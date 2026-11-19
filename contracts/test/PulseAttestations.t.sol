// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PulseAttestations} from "../src/PulseAttestations.sol";

contract PulseAttestationsTest is Test {
    PulseAttestations att;
    address attester = makeAddr("attester");
    address stranger = makeAddr("stranger");
    uint32 today;

    function setUp() public {
        vm.warp(1_795_000_000); // 2026-11-18
        vm.roll(12_000_000);
        today = uint32(block.timestamp / 1 days);
        att = new PulseAttestations(attester);
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _leaf(uint32 txs) internal view returns (bytes32) {
        return att.leafHash(keccak256("demo"), keccak256(abi.encode(new address[](0))), 1, 2, txs, txs / 2, bytes32(uint256(txs)));
    }

    function test_attestAndVerifyThreeLeafTree() public {
        bytes32 a = _leaf(10);
        bytes32 b = _leaf(20);
        bytes32 c = _leaf(30);
        // Layers: [a, b, c] -> [h(a,b), c] -> root. The odd node is carried up unchanged.
        bytes32 ab = _pair(a, b);
        bytes32 root = _pair(ab, c);

        vm.prank(attester);
        att.attest(today, root, 3, uint64(block.number - 1));
        (bytes32 r, uint32 n, uint64 snap, uint64 at) = att.attestations(today);
        assertEq(r, root);
        assertEq(n, 3);
        assertEq(snap, block.number - 1);
        assertEq(at, block.timestamp);
        assertEq(att.latestEpoch(), today);

        bytes32[] memory pa = new bytes32[](2);
        pa[0] = b;
        pa[1] = c;
        assertTrue(att.verify(today, a, pa));
        bytes32[] memory pc = new bytes32[](1);
        pc[0] = ab;
        assertTrue(att.verify(today, c, pc));

        // A changed number, a wrong epoch or a truncated proof all fail.
        assertFalse(att.verify(today, _leaf(11), pa));
        assertFalse(att.verify(today - 1, a, pa));
        bytes32[] memory short = new bytes32[](1);
        short[0] = b;
        assertFalse(att.verify(today, a, short));
        // The inner node itself is not a valid leaf (double hashing blocks second preimages).
        bytes32[] memory none = new bytes32[](1);
        none[0] = c;
        assertFalse(att.verify(today, keccak256(bytes.concat(keccak256(abi.encode(ab)))), none));
    }

    function test_epochZeroCanNeverBeWritten() public {
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(PulseAttestations.EpochNotAfterLatest.selector, uint32(0), uint32(0)));
        att.attest(0, bytes32(uint256(1)), 1, 1);
    }

    function test_verifyStatsHashesTheNumbersAndChecksTheWindow() public {
        bytes32 slug = keccak256("demo");
        bytes32 cs = keccak256(abi.encode(new address[](0)));
        uint64 snap = uint64(block.number - 1);
        bytes32 a = att.leafHash(slug, cs, 1, snap, 39, 16, bytes32(uint256(7)));
        bytes32 b = _leaf(20);
        vm.prank(attester);
        att.attest(today, _pair(a, b), 2, snap);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = b;
        assertTrue(att.verifyStats(today, slug, cs, 1, snap, 39, 16, bytes32(uint256(7)), proof));
        assertFalse(att.verifyStats(today, slug, cs, 1, snap, 40, 16, bytes32(uint256(7)), proof)); // inflated
        assertFalse(att.verifyStats(today, slug, cs, 1, snap - 1, 39, 16, bytes32(uint256(7)), proof)); // other window
        assertFalse(att.verifyStats(today - 1, slug, cs, 1, snap, 39, 16, bytes32(uint256(7)), proof)); // not attested
        // An inner node passed to verify() as a "leaf" folds to the root; verifyStats can't be fooled that way.
        bytes32[] memory empty = new bytes32[](0);
        assertTrue(att.verify(today, _pair(a, b), empty));
    }

    function test_onlyAttesterCanPost() public {
        vm.prank(stranger);
        vm.expectRevert(PulseAttestations.NotAttester.selector);
        att.attest(today, bytes32(uint256(1)), 1, 1);
    }

    function test_historyIsAppendOnlyAndInOrder() public {
        vm.startPrank(attester);
        att.attest(today - 1, bytes32(uint256(1)), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(PulseAttestations.EpochNotAfterLatest.selector, today - 1, today - 1));
        att.attest(today - 1, bytes32(uint256(2)), 1, 1); // can't rewrite
        vm.expectRevert(abi.encodeWithSelector(PulseAttestations.EpochNotAfterLatest.selector, today - 2, today - 1));
        att.attest(today - 2, bytes32(uint256(2)), 1, 1); // can't backdate
        vm.expectRevert(abi.encodeWithSelector(PulseAttestations.EpochInFuture.selector, today + 1));
        att.attest(today + 1, bytes32(uint256(2)), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(PulseAttestations.SnapshotNotInPast.selector, uint64(block.number)));
        att.attest(today, bytes32(uint256(2)), 1, uint64(block.number));
        vm.expectRevert(PulseAttestations.EmptyRoot.selector);
        att.attest(today, bytes32(0), 1, 1);
        att.attest(today, bytes32(uint256(2)), 1, 1); // a skipped day is fine
        vm.stopPrank();
        (bytes32 r,,,) = att.attestations(today - 1);
        assertEq(r, bytes32(uint256(1)));
    }

    function test_adminRotatesAttesterWithTwoStepOwnership() public {
        address next = makeAddr("next");
        vm.prank(stranger);
        vm.expectRevert(PulseAttestations.NotOwner.selector);
        att.setAttester(next);
        att.setAttester(next);
        assertEq(att.attester(), next);
        vm.expectRevert(PulseAttestations.ZeroAddress.selector);
        att.setAttester(address(0));

        att.transferOwnership(stranger);
        assertEq(att.owner(), address(this));
        vm.prank(next);
        vm.expectRevert(PulseAttestations.NotOwner.selector);
        att.acceptOwnership();
        vm.prank(stranger);
        att.acceptOwnership();
        assertEq(att.owner(), stranger);
        assertEq(att.pendingOwner(), address(0));
    }

    function test_rejectsZeroAttester() public {
        vm.expectRevert(PulseAttestations.ZeroAddress.selector);
        new PulseAttestations(address(0));
    }

    /// Any leaf of an 8-leaf tree verifies with its proof; flipping a bit never does.
    function testFuzz_proofs(bytes32 seed, uint8 idx, uint8 bit) public {
        uint256 i = idx % 8;
        bytes32[] memory layer = new bytes32[](8);
        for (uint256 k = 0; k < 8; k++) layer[k] = keccak256(abi.encode(seed, k));
        bytes32[] memory proof = new bytes32[](3);
        uint256 pos = i;
        for (uint256 level = 0; level < 3; level++) {
            proof[level] = layer[pos ^ 1];
            bytes32[] memory next = new bytes32[](layer.length / 2);
            for (uint256 k = 0; k < next.length; k++) next[k] = _pair(layer[2 * k], layer[2 * k + 1]);
            layer = next;
            pos /= 2;
        }
        vm.prank(attester);
        att.attest(today, layer[0], 8, 1);
        bytes32 leaf = keccak256(abi.encode(seed, i));
        assertTrue(att.verify(today, leaf, proof));
        assertFalse(att.verify(today, leaf ^ bytes32(uint256(1) << bit), proof));
    }
}

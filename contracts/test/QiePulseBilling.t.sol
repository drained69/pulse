// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {QiePulseBilling} from "../src/QiePulseBilling.sol";

contract MockUSDC {
    string public symbol = "QUSDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public returnFalse;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function setReturnFalse(bool v) external {
        returnFalse = v;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transferFrom(address f, address t, uint256 amt) external returns (bool) {
        if (returnFalse) return false;
        require(allowance[f][msg.sender] >= amt, "allowance");
        require(balanceOf[f] >= amt, "balance");
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[t] += amt;
        return true;
    }
}

contract QiePulseBillingTest is Test {
    event Subscribed(address indexed account, uint8 indexed planId, uint32 periods, uint256 amount, uint64 paidUntil);

    MockUSDC usdc;
    QiePulseBilling billing;
    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);
    uint256 constant PRICE = 9e6; // 9 QUSDC
    uint32 constant MONTH = 30 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        billing = new QiePulseBilling(address(usdc), treasury, PRICE, MONTH);
        usdc.mint(alice, 1000e6);
        vm.prank(alice);
        usdc.approve(address(billing), type(uint256).max);
    }

    function test_subscribePaysTreasuryAndSetsPaidUntil() public {
        vm.expectEmit(true, true, false, true);
        emit Subscribed(alice, 1, 2, 18e6, uint64(block.timestamp + 2 * MONTH));
        vm.prank(alice);
        uint64 until = billing.subscribe(1, 2, type(uint256).max);
        assertEq(until, block.timestamp + 2 * MONTH);
        assertEq(billing.paidUntil(alice), until);
        assertEq(usdc.balanceOf(treasury), 18e6);
        assertEq(usdc.balanceOf(address(billing)), 0, "contract holds no funds");
        assertTrue(billing.isActive(alice));
    }

    function test_renewalExtendsFromCurrentExpiry() public {
        vm.startPrank(alice);
        billing.subscribe(1, 1, type(uint256).max);
        vm.warp(block.timestamp + 10 days);
        uint64 until = billing.subscribe(1, 1, type(uint256).max);
        vm.stopPrank();
        assertEq(until, 1_800_000_000 + 2 * MONTH);
    }

    function test_lapsedRenewalStartsFromNow() public {
        vm.prank(alice);
        billing.subscribe(1, 1, type(uint256).max);
        vm.warp(block.timestamp + 90 days);
        assertFalse(billing.isActive(alice));
        vm.prank(alice);
        uint64 until = billing.subscribe(1, 1, type(uint256).max);
        assertEq(until, block.timestamp + MONTH);
    }

    function test_subscribeForGiftsAnotherAccount() public {
        address team = address(0x7EA);
        vm.prank(alice);
        billing.subscribeFor(team, 1, 1, type(uint256).max);
        assertTrue(billing.isActive(team));
        assertFalse(billing.isActive(alice));
    }

    function test_revertsOnBadInput() public {
        vm.startPrank(alice);
        vm.expectRevert(QiePulseBilling.BadPeriods.selector);
        billing.subscribe(1, 0, type(uint256).max);
        vm.expectRevert(QiePulseBilling.BadPeriods.selector);
        billing.subscribe(1, 25, type(uint256).max);
        vm.expectRevert(QiePulseBilling.PlanInactive.selector);
        billing.subscribe(2, 1, type(uint256).max);
        vm.expectRevert(QiePulseBilling.ZeroAddress.selector);
        billing.subscribeFor(address(0), 1, 1, type(uint256).max);
        vm.stopPrank();
    }

    function test_maxAmountProtectsAgainstPriceChange() public {
        // Alice signs for 2 periods at the current price, then the owner raises it.
        billing.setPlan(1, 20e6, MONTH, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(QiePulseBilling.PriceAboveMax.selector, 40e6, 2 * PRICE));
        billing.subscribe(1, 2, 2 * PRICE);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(billing.quote(1, 2), 40e6);
    }

    function test_revertsWhenTokenReturnsFalse() public {
        usdc.setReturnFalse(true);
        vm.prank(alice);
        vm.expectRevert(QiePulseBilling.TransferFailed.selector);
        billing.subscribe(1, 1, type(uint256).max);
        assertEq(billing.paidUntil(alice), 0, "state rolled back");
    }

    function test_revertsWithoutAllowance() public {
        address bob = address(0xB0B);
        usdc.mint(bob, 100e6);
        vm.prank(bob);
        vm.expectRevert();
        billing.subscribe(1, 1, type(uint256).max);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(alice);
        vm.expectRevert(QiePulseBilling.NotOwner.selector);
        billing.setPlan(1, 1, 1, true);
        vm.prank(alice);
        vm.expectRevert(QiePulseBilling.NotOwner.selector);
        billing.setTreasury(alice);

        billing.setPlan(1, 5e6, MONTH, true);
        vm.prank(alice);
        billing.subscribe(1, 1, type(uint256).max);
        assertEq(usdc.balanceOf(treasury), 5e6);

        billing.setPlan(1, 5e6, MONTH, false);
        vm.prank(alice);
        vm.expectRevert(QiePulseBilling.PlanInactive.selector);
        billing.subscribe(1, 1, type(uint256).max);
    }

    function test_twoStepOwnership() public {
        billing.transferOwnership(alice);
        assertEq(billing.owner(), address(this));
        vm.prank(address(0xBAD));
        vm.expectRevert(QiePulseBilling.NotOwner.selector);
        billing.acceptOwnership();
        vm.prank(alice);
        billing.acceptOwnership();
        assertEq(billing.owner(), alice);
    }

    function test_constructorRejectsBadArgs() public {
        vm.expectRevert(QiePulseBilling.ZeroAddress.selector);
        new QiePulseBilling(address(0), treasury, PRICE, MONTH);
        vm.expectRevert(QiePulseBilling.ZeroAddress.selector);
        new QiePulseBilling(address(0x1234), treasury, PRICE, MONTH); // no code
        vm.expectRevert(QiePulseBilling.BadPlan.selector);
        new QiePulseBilling(address(usdc), treasury, 0, MONTH);
    }

    function testFuzz_paidUntilMonotonic(uint32 p1, uint32 p2, uint32 gap) public {
        p1 = uint32(bound(p1, 1, 24));
        p2 = uint32(bound(p2, 1, 24));
        gap = uint32(bound(gap, 0, 5 * 365 days));
        vm.startPrank(alice);
        uint64 a = billing.subscribe(1, p1, type(uint256).max);
        vm.warp(block.timestamp + gap);
        uint64 b = billing.subscribe(1, p2, type(uint256).max);
        vm.stopPrank();
        assertGt(b, a);
        assertGe(b, block.timestamp + uint256(MONTH) * p2);
        assertEq(usdc.balanceOf(treasury), PRICE * (uint256(p1) + p2));
    }
}

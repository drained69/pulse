// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title QIE Pulse traction attestations
/// @notice Once a day QIE Pulse commits a Merkle root of every public project's traction
///         numbers (transactions and distinct wallets over a 30-day window, plus a hash of
///         the exact transaction set) to this contract. Anyone can then check a project's
///         numbers without trusting the QIE Pulse server:
///           1. recompute the numbers from the chain (explorer or RPC),
///           2. hash them into a leaf and fold the Merkle proof into a root,
///           3. compare with the root stored here (or call `verify`).
///
/// @dev    History is append-only: an epoch can be written once, epochs must increase, and
///         an epoch can't be in the future, so past days can't be rewritten or backdated.
///         Leaves are double-hashed and pairs are hashed in sorted order (the OpenZeppelin
///         StandardMerkleTree convention), which blocks second-preimage proofs.
contract PulseAttestations {
    struct Attestation {
        bytes32 root;
        uint32 leaves; // number of projects in the tree
        uint64 snapshotBlock; // numbers are as of this block (inclusive)
        uint64 attestedAt; // block.timestamp when posted
    }

    address public owner;
    address public pendingOwner;
    /// @notice The QIE Pulse server key allowed to post roots. It holds gas only, never funds.
    address public attester;
    /// @notice Latest epoch (UTC day number = unix time / 86400) with an attestation.
    uint32 public latestEpoch;

    mapping(uint32 => Attestation) public attestations;

    event Attested(uint32 indexed epoch, bytes32 indexed root, uint32 leaves, uint64 snapshotBlock);
    event AttesterSet(address indexed attester);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotAttester();
    error ZeroAddress();
    error EmptyRoot();
    error EpochNotAfterLatest(uint32 epoch, uint32 latest);
    error EpochInFuture(uint32 epoch);
    error SnapshotNotInPast(uint64 snapshotBlock);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address attester_) {
        if (attester_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        attester = attester_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AttesterSet(attester_);
    }

    /// @notice Post the Merkle root for one epoch. Only the attester; each epoch once, in order.
    function attest(uint32 epoch, bytes32 root, uint32 leaves, uint64 snapshotBlock) external {
        if (msg.sender != attester) revert NotAttester();
        if (root == bytes32(0)) revert EmptyRoot();
        if (latestEpoch != 0 && epoch <= latestEpoch) revert EpochNotAfterLatest(epoch, latestEpoch);
        if (uint256(epoch) > block.timestamp / 1 days) revert EpochInFuture(epoch);
        if (snapshotBlock >= block.number) revert SnapshotNotInPast(snapshotBlock);
        attestations[epoch] = Attestation(root, leaves, snapshotBlock, uint64(block.timestamp));
        latestEpoch = epoch;
        emit Attested(epoch, root, leaves, snapshotBlock);
    }

    /// @notice True if `leaf` (already double-hashed) is in the tree attested for `epoch`.
    function verify(uint32 epoch, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = attestations[epoch].root;
        return root != bytes32(0) && processProof(leaf, proof) == root;
    }

    /// @notice The leaf for one project's numbers, exactly as QIE Pulse and its verifier CLI compute it.
    /// @param slugHash      keccak256 of the project's page slug (e.g. keccak256("patungan"))
    /// @param contractsHash keccak256(abi.encode(address[])) of its contracts, ascending
    /// @param fromTs        window start (unix seconds, inclusive): snapshot block time - 30 days
    /// @param toBlock       window end (block number, inclusive) = the attestation's snapshotBlock
    /// @param txCount       successful transactions sent directly to those contracts in the window
    /// @param walletCount   distinct senders of those transactions
    /// @param txSetHash     keccak256 of the ascending, concatenated hashes of those transactions
    function leafHash(
        bytes32 slugHash,
        bytes32 contractsHash,
        uint64 fromTs,
        uint64 toBlock,
        uint32 txCount,
        uint32 walletCount,
        bytes32 txSetHash
    ) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(keccak256(abi.encode(slugHash, contractsHash, fromTs, toBlock, txCount, walletCount, txSetHash)))
        );
    }

    /// @notice Fold a Merkle proof into the root it implies (sorted-pair hashing).
    function processProof(bytes32 leaf, bytes32[] calldata proof) public pure returns (bytes32 computed) {
        computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed = computed < p ? keccak256(abi.encode(computed, p)) : keccak256(abi.encode(p, computed));
        }
    }

    // ───────── admin ─────────

    function setAttester(address attester_) external onlyOwner {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterSet(attester_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}

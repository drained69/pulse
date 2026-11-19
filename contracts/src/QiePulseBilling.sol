// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title QIE Pulse billing
/// @notice Pay for a QIE Pulse plan in QUSDC. The contract never holds funds:
///         payments go straight to the treasury, and `paidUntil` is the on-chain
///         record the QIE Pulse server reads (via the `Subscribed` event) to
///         unlock the plan for the paying address.
contract QiePulseBilling {
    struct Plan {
        uint256 price; // per period, in token units (QUSDC has 6 decimals)
        uint32 duration; // seconds per period
        bool active;
    }

    uint32 public constant MAX_PERIODS = 24;

    IERC20 public immutable token;
    address public owner;
    address public pendingOwner;
    address public treasury;

    mapping(uint8 => Plan) public plans;
    mapping(address => uint64) public paidUntil;

    event Subscribed(address indexed account, uint8 indexed planId, uint32 periods, uint256 amount, uint64 paidUntil);
    event PlanSet(uint8 indexed planId, uint256 price, uint32 duration, bool active);
    event TreasurySet(address indexed treasury);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error PlanInactive();
    error BadPeriods();
    error BadPlan();
    error TransferFailed();
    error PriceAboveMax(uint256 amount, uint256 maxAmount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token_, address treasury_, uint256 proPrice, uint32 proDuration) {
        if (token_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert ZeroAddress();
        token = IERC20(token_);
        owner = msg.sender;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasurySet(treasury_);
        _setPlan(1, proPrice, proDuration, true);
    }

    /// @notice Pay for `periods` periods of `planId` for yourself.
    /// @param maxAmount The most you agree to pay in total. Protects you if the price
    ///        changes between signing and inclusion (the owner cannot overcharge you).
    function subscribe(uint8 planId, uint32 periods, uint256 maxAmount) external returns (uint64) {
        return _subscribe(msg.sender, planId, periods, maxAmount);
    }

    /// @notice Pay for someone else's plan (e.g. a team wallet or a Safe).
    function subscribeFor(address account, uint8 planId, uint32 periods, uint256 maxAmount) external returns (uint64) {
        if (account == address(0)) revert ZeroAddress();
        return _subscribe(account, planId, periods, maxAmount);
    }

    /// @notice Total price for `periods` periods of `planId`.
    function quote(uint8 planId, uint32 periods) external view returns (uint256) {
        return plans[planId].price * periods;
    }

    function _subscribe(address account, uint8 planId, uint32 periods, uint256 maxAmount) internal returns (uint64 until) {
        Plan memory p = plans[planId];
        if (!p.active) revert PlanInactive();
        if (periods == 0 || periods > MAX_PERIODS) revert BadPeriods();

        uint256 amount = p.price * periods;
        if (amount > maxAmount) revert PriceAboveMax(amount, maxAmount);
        uint256 start = paidUntil[account] > block.timestamp ? paidUntil[account] : block.timestamp;
        until = uint64(start + uint256(p.duration) * periods);
        paidUntil[account] = until;

        _safeTransferFrom(msg.sender, treasury, amount);
        emit Subscribed(account, planId, periods, amount, until);
    }

    function isActive(address account) external view returns (bool) {
        return paidUntil[account] > block.timestamp;
    }

    // ───────── admin ─────────

    function setPlan(uint8 planId, uint256 price, uint32 duration, bool active) external onlyOwner {
        _setPlan(planId, price, duration, active);
    }

    function _setPlan(uint8 planId, uint256 price, uint32 duration, bool active) internal {
        if (planId == 0 || duration == 0 || (active && price == 0)) revert BadPlan();
        plans[planId] = Plan(price, duration, active);
        emit PlanSet(planId, price, duration, active);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
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

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title LatchInstructionSender
/// @notice On-chain entry point for LATCH — the confidential executor.
///
/// Most of LATCH's traffic never comes through here. Arming an intent and
/// asking its status are *direct actions*: they go straight to the enclave via
/// the proxy, so the intent never touches the chain and there is nothing for an
/// observer to read. That is the whole point.
///
/// What does come through here is the part that should be public:
///
///   CANCEL    a revocation the user can prove they made
///   RECLAIM   a deadline the enclave cannot talk its way out of
///
/// An enclave that could quietly refuse to act would be a censor. Routing the
/// exits on-chain is what stops that being a matter of trust.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract LatchInstructionSender {
    /// @notice Operation type for all LATCH actions.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_LATCH = bytes32("LATCH");

    /// @notice Revoke an armed intent. Publicly auditable by design.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_CANCEL = bytes32("CANCEL");

    /// @notice Ask whether an intent is still waiting. Lifecycle only.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_STATUS = bytes32("STATUS");

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice A commitment the caller has publicly asked the enclave to drop.
    /// @dev The enclave is not required to observe this to be safe — the user's
    /// real guarantee is the deadline — but a recorded revocation means a
    /// misbehaving enclave can be shown to have ignored one.
    mapping(bytes32 commitment => address canceller) public cancelledBy;

    event IntentCancelRequested(bytes32 indexed commitment, address indexed by);

    error AlreadyCancelled(bytes32 commitment);

    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Publicly revoke an armed intent.
    /// @param _commitment keccak256 of the operation — the same value the XRPL
    /// memo published. Naming it here reveals nothing: it is already public.
    function cancelIntent(bytes32 _commitment) external payable {
        require(cancelledBy[_commitment] == address(0), AlreadyCancelled(_commitment));
        cancelledBy[_commitment] = msg.sender;
        emit IntentCancelRequested(_commitment, msg.sender);

        _send(OP_COMMAND_CANCEL, abi.encode(_commitment));
    }

    /// @notice Ask the enclave for an intent's lifecycle state.
    /// @dev The same question can be asked off-chain for free; this exists so
    /// the answer can be recorded when a user wants it on the record.
    function requestStatus(bytes32 _commitment) external payable {
        _send(OP_COMMAND_STATUS, abi.encode(_commitment));
    }

    /// @notice Whether a commitment has a recorded revocation.
    function isCancelled(bytes32 _commitment) external view returns (bool) {
        return cancelledBy[_commitment] != address(0);
    }

    function _send(bytes32 _opCommand, bytes memory _message) private {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_LATCH,
            opCommand: _opCommand,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}

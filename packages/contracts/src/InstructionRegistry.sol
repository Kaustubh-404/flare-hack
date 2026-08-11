// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/**
 * The human-readable instruction directory.
 *
 * This is a safety feature, not decoration. An XRPL user signing a `0xFE` memo
 * is signing 32 bytes of hash — they cannot see what they are authorising.
 * Blind-signing an opaque commitment is exactly how people get robbed.
 *
 * A dApp registers `(target, selector) -> template`, and any wallet can render
 * "Deposit {0} XRP into MockVault" instead of hex. The registry is advisory: it
 * changes what a user *sees*, never what executes. Nothing here can authorise a
 * call, so a malicious entry can mislabel but not steal — which is why anyone
 * may register their own contracts, but only the registrant may edit them.
 */
contract InstructionRegistry {
    struct Entry {
        address registrant;
        string appName;
        string template;
        bool exists;
    }

    /// keccak256(target, selector) => entry
    mapping(bytes32 key => Entry entry) private _entries;

    event InstructionRegistered(
        address indexed target, bytes4 indexed selector, address indexed registrant, string appName, string template
    );
    event InstructionRemoved(address indexed target, bytes4 indexed selector);

    error NotRegistrant(address registrant, address caller);
    error EmptyTemplate();
    error UnknownInstruction(address target, bytes4 selector);

    function keyFor(address _target, bytes4 _selector) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_target, _selector));
    }

    function register(address _target, bytes4 _selector, string calldata _appName, string calldata _template)
        external
    {
        require(bytes(_template).length > 0, EmptyTemplate());
        bytes32 key = keyFor(_target, _selector);
        Entry storage e = _entries[key];
        // First registration claims it; afterwards only the registrant may edit.
        require(!e.exists || e.registrant == msg.sender, NotRegistrant(e.registrant, msg.sender));

        e.registrant = msg.sender;
        e.appName = _appName;
        e.template = _template;
        e.exists = true;

        emit InstructionRegistered(_target, _selector, msg.sender, _appName, _template);
    }

    function remove(address _target, bytes4 _selector) external {
        bytes32 key = keyFor(_target, _selector);
        Entry storage e = _entries[key];
        require(e.exists, UnknownInstruction(_target, _selector));
        require(e.registrant == msg.sender, NotRegistrant(e.registrant, msg.sender));
        delete _entries[key];
        emit InstructionRemoved(_target, _selector);
    }

    function describe(address _target, bytes4 _selector)
        external
        view
        returns (string memory appName, string memory template, address registrant)
    {
        Entry storage e = _entries[keyFor(_target, _selector)];
        require(e.exists, UnknownInstruction(_target, _selector));
        return (e.appName, e.template, e.registrant);
    }

    function isRegistered(address _target, bytes4 _selector) external view returns (bool) {
        return _entries[keyFor(_target, _selector)].exists;
    }
}

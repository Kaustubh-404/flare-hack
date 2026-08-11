// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/**
 * Gate 1 target.
 *
 * The narrowest possible proof that the whole chain works: an XRPL `Payment`
 * carrying a 42-byte `0xFE` memo causes `increment()` to run on Coston2, called
 * by a personal account that did not exist when the payment was signed.
 *
 * `lastCaller` is what makes it a proof rather than a vibe — it records the
 * personal account, so we can assert the call arrived through the Smart Accounts
 * path and not from an EOA poking the contract directly.
 */
contract Counter {
    uint256 public count;
    address public lastCaller;

    event Incremented(uint256 newCount, address indexed caller);

    function increment() external {
        count += 1;
        lastCaller = msg.sender;
        emit Incremented(count, msg.sender);
    }

    /// Batch marker: proves a multi-call user operation ran in order.
    function incrementBy(uint256 _n) external {
        count += _n;
        lastCaller = msg.sender;
        emit Incremented(count, msg.sender);
    }
}

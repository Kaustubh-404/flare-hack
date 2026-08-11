// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * Stand-in for FXRP on Coston2 so the ONESIG demo can run end to end before the
 * FAssets direct-minting leg is wired up.
 *
 * 6 decimals to match XRP's drops, so amounts in the demo read the way a user
 * expects. Freely mintable — this is a testnet prop, not a token.
 */
contract MockFXRP is IERC20 {
    string public constant name = "Mock FXRP";
    string public constant symbol = "mFXRP";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance(uint256 available, uint256 requested);
    error InsufficientAllowance(uint256 available, uint256 requested);

    function mint(address _to, uint256 _amount) external {
        totalSupply += _amount;
        balanceOf[_to] += _amount;
        emit Transfer(address(0), _to, _amount);
    }

    function transfer(address _to, uint256 _amount) external returns (bool) {
        _transfer(msg.sender, _to, _amount);
        return true;
    }

    function approve(address _spender, uint256 _amount) external returns (bool) {
        allowance[msg.sender][_spender] = _amount;
        emit Approval(msg.sender, _spender, _amount);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _amount) external returns (bool) {
        uint256 allowed = allowance[_from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= _amount, InsufficientAllowance(allowed, _amount));
            allowance[_from][msg.sender] = allowed - _amount;
        }
        _transfer(_from, _to, _amount);
        return true;
    }

    function _transfer(address _from, address _to, uint256 _amount) private {
        uint256 bal = balanceOf[_from];
        require(bal >= _amount, InsufficientBalance(bal, _amount));
        balanceOf[_from] = bal - _amount;
        balanceOf[_to] += _amount;
        emit Transfer(_from, _to, _amount);
    }
}

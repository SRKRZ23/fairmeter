#!/usr/bin/env bash
# One live FairMeter cycle on Aevum testnet: approve -> open -> agent signs -> provider settles actual cost -> revoke.
# Keys are Foundry keystores in $KEYDIR (default ~/.aevum-test): deployer.json (owner), agent.json, provider.json, pw.
set -euo pipefail
KEYDIR=${KEYDIR:-$HOME/.aevum-test}
R=${AEVUM_RPC:-https://rpc-test.qday.info}
M=${FAIRMETER:?set FAIRMETER=<address>}
T=0x456569838f1d43009A91ebA4263147Afd7233483
key() { echo --keystore "$KEYDIR/$1.json" --password-file "$KEYDIR/pw"; }
addr() { cast wallet address $(key "$1"); }
tx() { cast send "$@" --rpc-url "$R" --legacy --json | jq -r '"  tx \(.transactionHash) status=\(.status) gas=\(.gasUsed)"'; }
OWNER=$(addr deployer); AG=$(addr agent); PR=$(addr provider)
echo "owner $OWNER  agent $AG  provider $PR"
if [ "$(cast balance "$PR" --rpc-url "$R")" = "0" ]; then echo "fund provider gas"; tx "$PR" --value 0.05ether $(key deployer); fi
echo "approve 2 tUSD8"; tx $T "approve(address,uint256)" "$M" 2000000 $(key deployer)
EXP=$(( $(date +%s) + 7*86400 ))
echo "open mandate: 2.00 locked, cap 2.00, max 0.50 per request, 7 days"
tx "$M" "open(address,address,uint256,uint256,uint256,uint64)" "$AG" "$PR" 2000000 2000000 500000 "$EXP" $(key deployer)
ID=$(( $(cast call "$M" "nextMandateId()(uint256)" --rpc-url "$R") - 1 )); echo "  mandate #$ID"
REQ=$(cast keccak "smoke-$(date +%s)"); DL=$(( $(date +%s) + 600 ))
DIG=$(cast call "$M" "usageDigest(uint256,bytes32,uint256,uint64)(bytes32)" "$ID" "$REQ" 400000 "$DL" --rpc-url "$R")
SIG=$(cast wallet sign --no-hash "$DIG" $(key agent))
echo "agent allows up to 0.40; dry-run status (0 = Ok): $(cast call "$M" 'check(uint256,bytes32,uint256,uint64,uint256,address,bytes)(uint8)' "$ID" "$REQ" 400000 "$DL" 37000 "$PR" "$SIG" --rpc-url "$R")"
echo "provider settles the actual cost 0.037"
tx "$M" "settle(uint256,bytes32,uint256,uint64,uint256,bytes32,bytes)" "$ID" "$REQ" 400000 "$DL" 37000 "$(cast keccak receipt-$REQ)" "$SIG" $(key provider)
echo "  provider tUSD8: $(cast call $T 'balanceOf(address)(uint256)' "$PR" --rpc-url "$R")"
echo "replay the same authorization (must fail, status 6 = AlreadySettled): $(cast call "$M" 'check(uint256,bytes32,uint256,uint64,uint256,address,bytes)(uint8)' "$ID" "$REQ" 400000 "$DL" 37000 "$PR" "$SIG" --rpc-url "$R")"
echo "owner revokes"; tx "$M" "revoke(uint256)" "$ID" $(key deployer)
echo "  owner tUSD8: $(cast call $T 'balanceOf(address)(uint256)' "$OWNER" --rpc-url "$R")   contract tUSD8: $(cast call $T 'balanceOf(address)(uint256)' "$M" --rpc-url "$R")"

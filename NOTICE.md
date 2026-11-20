# Third-party notices

FairMeter is MIT licensed (see [LICENSE](LICENSE)). It started from the Aevum Starter Kit (MIT, PQA Labs,
https://github.com/qday-io/aevum-starter-kit, commit e87bcff) and builds on the open-source projects below.
None of their code is copied into this repository: the Solidity libraries are git submodules that keep
their own LICENSE files, and the JavaScript packages are installed from npm.

## Solidity libraries (`contracts/lib`, git submodules)

| Project | Version | License | Source |
|---|---|---|---|
| forge-std | v1.9.6 | MIT or Apache-2.0 | https://github.com/foundry-rs/forge-std |
| OpenZeppelin Contracts | v5.1.0 | MIT | https://github.com/OpenZeppelin/openzeppelin-contracts |

## JavaScript packages (direct dependencies)

| Package | Version | License | Used in |
|---|---|---|---|
| next | 16.4.5 | MIT | web |
| react, react-dom | 19.2.0 | MIT | web |
| @rainbow-me/rainbowkit | 2.2.11 | MIT | web |
| wagmi | 2.19.5 | MIT | web |
| @tanstack/react-query | 5.90.2 | MIT | web |
| viem | 2.57.12 | MIT | web, examples, packages/aevum, packages/fairmeter |
| @noble/post-quantum | 0.7.1 | MIT | packages/fairmeter (ML-DSA-65, FIPS 204) |
| tsx | 4.23.15 | MIT | examples (dev) |
| typescript | 5.9.3 | Apache-2.0 | all (dev) |

Their own dependencies carry their own licenses. To list them all, run `pnpm licenses list` in the repo root.

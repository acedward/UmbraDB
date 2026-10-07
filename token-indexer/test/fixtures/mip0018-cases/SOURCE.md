# Provenance of the copied Stagenet case expectations

Every `*.json` file in this folder is a byte-for-byte copy of a file of the MIP-0018 reference implementation at the
pinned commit below (copied with `git show <commit>:<path>`; never edited). The tests recompute each SHA-256 below and
fail on a modified, missing or unlisted copy. A row whose first column is `—` names an upstream file that is not copied
(its hash is compared with a copied file's).

| Field | Value |
|---|---|
| Upstream | `https://github.com/midnight-experiments/mip-0018.git`, branch `main` |
| Pinned at | **`e8295792d9363be37ff2f7f716c740fcdf3f195e`** |
| License | Apache-2.0 |

## Files

| This folder | Upstream path at the pin | SHA-256 |
|---|---|---|
| `C01/expected.json` | `deployments/stagenet/cases/C01/expected.json` | `f13b04ccac2c301e31271df9e75d174256e80c497444773a5f24e0721b1a2df8` |
| `C02/expected.json` | `deployments/stagenet/cases/C02/expected.json` | `3f8e219d0b9dce9e62458e4377b924d71dbbe111c6c458b67b16c9168215e13e` |
| `C03/expected.json` | `deployments/stagenet/cases/C03/expected.json` | `f747d0fd1dd77942637128418b9ce974073c41483b9411e5e6d301ce70a7317e` |
| `C04/expected.json` | `deployments/stagenet/cases/C04/expected.json` | `441289bd2d6b504a95003d664c0f4104d35c459570b242e8409da22c0dff6879` |
| `C05/expected.json` | `deployments/stagenet/cases/C05/expected.json` | `82eea13815a0928c2d4b979c636a1d2f0a59c0724e82c970eb8c07fee721b77e` |
| `C06/expected-after-publish.json` | `deployments/stagenet/cases/C06/expected-after-publish.json` | `908e2037192f8f236106e1aee6d2a0e7bf69042f6ff1605d8006446aabe3b52d` |
| `C06/expected-after-rename.json` | `deployments/stagenet/cases/C06/expected-after-rename.json` | `843b2d6ea522c296b3b465f49abc8569817953860c1c1da5cd4f1dc63fa7921a` |
| `C06/expected-after-revive.json` | `deployments/stagenet/cases/C06/expected-after-revive.json` | `6645395ecc23aa6e33f965986bc8da3fe83c3644cfa431bc452d47eec7da8bb2` |
| `C06/expected-after-withdraw-again.json` | `deployments/stagenet/cases/C06/expected-after-withdraw-again.json` | `f5a525aaa0589c5808c7804fed5e79c93a35feeb6ba7c0d0ec2384f1a66c49c6` |
| `C06/expected-after-withdraw.json` | `deployments/stagenet/cases/C06/expected-after-withdraw.json` | `f5a525aaa0589c5808c7804fed5e79c93a35feeb6ba7c0d0ec2384f1a66c49c6` |
| `C06/expected.json` | `deployments/stagenet/cases/C06/expected.json` | `6645395ecc23aa6e33f965986bc8da3fe83c3644cfa431bc452d47eec7da8bb2` |
| `C07/expected.json` | `deployments/stagenet/cases/C07/expected.json` | `d3fdeac1743c114993cd32b3d54193db9a55ec2a880fe542994eb5a6746269d2` |
| `C08/expected.json` | `deployments/stagenet/cases/C08/expected.json` | `e27f307e45b45e7f62ca552401549d9536d9a7b876caedc1ef0bcb88b3fc9d55` |
| `C10/expected.json` | `deployments/stagenet/cases/C10/expected.json` | `908e2037192f8f236106e1aee6d2a0e7bf69042f6ff1605d8006446aabe3b52d` |
| `IDX/expected.json` | `deployments/stagenet/cases/IDX/expected.json` | `fe02a1983acb0ff0d5f6151d40ef117c33757ca4e28afb06c6460073d547c9d6` |
| `IDX/index-summary.json` | `deployments/stagenet/cases/IDX/index-summary.json` | `af31b41ced274cb72ea0641ec08d9a368f7a94da7ca31f67e0255448221bd749` |
| `U1/expected.json` | `deployments/stagenet/cases/U1/expected.json` | `1bd86e7e88590ec28e50c49da97887bbae9fc779049a055f6c682a0b15583af7` |
| `U1/index-summary.json` | `deployments/stagenet/cases/U1/index-summary.json` | `a91a1a9ae2ba7aab2caa0705db7ce5cea0d9fe2e6e1231743adfffcbd318466c` |
| — | `deployments/stagenet/cases/C09/expected.json` | `f13b04ccac2c301e31271df9e75d174256e80c497444773a5f24e0721b1a2df8` |

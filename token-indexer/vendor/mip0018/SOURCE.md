# Vendored MIP-0018 reference parts — provenance

Every file in this directory (except this `SOURCE.md`) is a **verbatim** copy of a file of the MIP-0018 reference
implementation at the pinned commit below. None of them is edited; a change upstream is re-vendored deliberately
(copy the files again, update this table). `token-indexer/test/mip0018-provenance.test.ts` recomputes every SHA-256
below in CI and fails on any modified, missing or unlisted file.

| Field | Value |
|---|---|
| Upstream | `https://github.com/midnight-experiments/mip-0018.git`, branch `main` |
| Pinned at | **`e8295792d9363be37ff2f7f716c740fcdf3f195e`** (2026-10-03) |
| License | Apache-2.0 (upstream `LICENSE` and `NOTICE` vendored next to this file; UmbraDB is Apache-2.0 too) |
| MIP text the upstream files are written against | MIP-0018 @ `274a84f221bcfc17e4b73e2c8b32fd8c028ea092` (per-key tombstones) |
| MIP text UmbraDB implements | MIP-0018 as in [PR #372](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/372) (followed as it moves; `token-indexer/README.md` states what UmbraDB applies on top of the vendored codec) |

Vendored parts:

- `codec/` — the dependency-free codec (`packages/codec`: `package.json`, `README.md`, `tsconfig.json`, `src/`).
  UmbraDB classifies and decodes every observed `Misc` event with it.
- `vectors/` — the vectors (`manifest.json`, `SHA256SUMS`, `README.md`, `schema/`, `payload/`, `state/`,
  `informative/`: 110 vectors, 67 normative and 43 informative) and the runner (`tools/run.ts` with the three files it
  imports: `runner-core.ts`, `compare.ts`, `common.ts`), plus `package.json`/`tsconfig.json` as upstream has them.
  The runner checks `SHA256SUMS` itself before every run (197 entries). The upstream `package.json` exports
  `./validate` (`tools/validate.ts`), which is not vendored; nothing here resolves that package name.

What is **not** vendored: the reference consumer (`packages/consumer`), the codec's own unit tests (they import
`@mip0018/vectors` by package name, which this path-import layout does not resolve; the codec is exercised here through
every payload vector instead), the vectors' own tests, the generator (`tools/generate.ts`), the schema validator
(`tools/validate.ts`, needs `ajv`) and `tools/bytes.ts` (used only by those). UmbraDB's state rules are its own code in
`token-indexer/mip0018/state.ts`.

How UmbraDB uses the files: plain path imports (`token-indexer/vendor/mip0018/codec/src/index.ts`), no npm `file:`
dependency; the root `tsconfig.json` sets `allowImportingTsExtensions` (it is `noEmit`) so `tsc` accepts the `.ts`
specifiers the upstream sources use. The runner is started as upstream documents it,
`node token-indexer/vendor/mip0018/vectors/tools/run.ts --consumer "<UmbraDB adapter>" …` (Node ≥ 24 strips the types).

## Files

| This directory | Upstream path at the pin | SHA-256 |
|---|---|---|
| `LICENSE` | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `NOTICE` | `NOTICE` | `7dfa652b7aee31524aa22622276d56cc5f96faf191ee353c5510aafd8af6e0f7` |
| `codec/README.md` | `packages/codec/README.md` | `409b24d286331dfeffb654f72895a281d97fe364e68503870e696157be0f773c` |
| `codec/package.json` | `packages/codec/package.json` | `f5d7eb61889c7c8a330065c2196c7cb65072433258c342bba0412975f675bac5` |
| `codec/src/classify.ts` | `packages/codec/src/classify.ts` | `57821aadf0af8772909408c601107f142ea5a7d19f3b2988fd23393b29049cf6` |
| `codec/src/constants.ts` | `packages/codec/src/constants.ts` | `df001f8ad28c5ff94307f82150a8443b6e1337dc121ccd71a5980ba4f7c143c7` |
| `codec/src/decode.ts` | `packages/codec/src/decode.ts` | `d9cee4a9b551448e3ffb90adedf8869e0749cf4b4350e97093b3d615363ffc41` |
| `codec/src/encode.ts` | `packages/codec/src/encode.ts` | `f8a80f80b28552cad1b2bc7a109b9b9c2a94c653ce839232dc90a8bd849611a7` |
| `codec/src/hex.ts` | `packages/codec/src/hex.ts` | `7ad2914d8bb983dde3ccc00edb05955afa948f9108894b57ae586686d4ab2e01` |
| `codec/src/index.ts` | `packages/codec/src/index.ts` | `0cbc8138f8a644245d2ac6e28b75253e7fc280a7eea13fee4e8b118ff8ad149e` |
| `codec/src/internal.ts` | `packages/codec/src/internal.ts` | `8d8631bf553b7d5f65c768b5fe33d0083cd559b0db7e3cf111ee77b983125272` |
| `codec/src/rules.ts` | `packages/codec/src/rules.ts` | `56b0ccb3224828ae484d19a6e168f67c658e31de9b798dac8bd3f5196c6a8873` |
| `codec/src/uri.ts` | `packages/codec/src/uri.ts` | `294e85c940cf58cd8c275060586e3715e901ae40577f047458365a544f2f4409` |
| `codec/src/values.ts` | `packages/codec/src/values.ts` | `3bcfd1325791913169a39f2416b959e6b388ffc09b7a608f267dee7f9875e83f` |
| `codec/tsconfig.json` | `packages/codec/tsconfig.json` | `1443a43102572e64d3bc659d5f5984a4fce3b087bdfac72a8d6bb4b55b3139ec` |
| `vectors/README.md` | `vectors/README.md` | `37f50b4a9baacc9b96162f13cfcac841b80244f7b2a4d5f6b40991a3be1182d8` |
| `vectors/SHA256SUMS` | `vectors/SHA256SUMS` | `3288d141de9f8e84acd7795a77a83b4dcc651dc63db4b8fa4e1a25e63fe5885b` |
| `vectors/informative/state/INF-COMMON-1.json` | `vectors/informative/state/INF-COMMON-1.json` | `0fb894474b262d0a966f6b5c322568ad94803d903cf13e5001b1db6bb7b2d603` |
| `vectors/informative/state/INF-STD-1.json` | `vectors/informative/state/INF-STD-1.json` | `28755e66a661944e379c920515dbefb748f203e26697ee9da2f3d885748b83bb` |
| `vectors/informative/state/INF-STD-2.json` | `vectors/informative/state/INF-STD-2.json` | `6f59f520faf154b080e3d0906cd64750938a4627e262c0fef1cc7eba5ce3993c` |
| `vectors/informative/state/INF-STD-3.json` | `vectors/informative/state/INF-STD-3.json` | `3750e62685796a7afd049a2e595c15308baa5a0e471b4e68b0b5394e1eef7f2e` |
| `vectors/informative/state/INF-STD-4.json` | `vectors/informative/state/INF-STD-4.json` | `4fc9b5fe41ad1dcad976dfb0420bcb32265130ba75922d05846d55df9c4ff857` |
| `vectors/informative/state/INF-STD-5.json` | `vectors/informative/state/INF-STD-5.json` | `de501fff5da2faa9fe4d8d7fdda07434a5ab20731df27b34c99f2c7f905699ea` |
| `vectors/informative/state/INF-STD-6.json` | `vectors/informative/state/INF-STD-6.json` | `1bd4ad0e7f297b42c4d9ded8ae9f2f4b4cf9e2982f0816e957dc829797f24e0a` |
| `vectors/informative/state/INF-STD-7.json` | `vectors/informative/state/INF-STD-7.json` | `2af37575ffff3c8c5c6b4dbef9e43e9678b8a2d54f1b626de0246c1a5afefc98` |
| `vectors/informative/uri/INF-URI-c01.bin` | `vectors/informative/uri/INF-URI-c01.bin` | `680ba46bb882705fe965366ebdd658dd09cb6729bc06bb12ae45efd9c7cab00d` |
| `vectors/informative/uri/INF-URI-c01.json` | `vectors/informative/uri/INF-URI-c01.json` | `79234a6a992a21767ca05b26981c4163f48a704e00df8d5289f7dfdd5a5ae93c` |
| `vectors/informative/uri/INF-URI-c02.bin` | `vectors/informative/uri/INF-URI-c02.bin` | `37b24904c2a41ec0ae8a996bde9877f79c7017ef0b77eec796f0082809a340d6` |
| `vectors/informative/uri/INF-URI-c02.json` | `vectors/informative/uri/INF-URI-c02.json` | `f18b4d88446a6a02af4395ce28a6448deada0aef006fd9bf8b0cfe40f51c8626` |
| `vectors/informative/uri/INF-URI-c03.bin` | `vectors/informative/uri/INF-URI-c03.bin` | `2e0ca2b06c0c2b5b943f02c89331f60083676a86ef38c21698662b9be707addc` |
| `vectors/informative/uri/INF-URI-c03.json` | `vectors/informative/uri/INF-URI-c03.json` | `3ac2cb02228179901273e877f71ddef21eca85dec91f05515aede92ea4b79c6e` |
| `vectors/informative/uri/INF-URI-c04.bin` | `vectors/informative/uri/INF-URI-c04.bin` | `eb77460513bca4267fcc4f17c6dc85cde619661006ecebf87076b5cbf33e6fb9` |
| `vectors/informative/uri/INF-URI-c04.json` | `vectors/informative/uri/INF-URI-c04.json` | `cbf17c274c9cf33a7e82caee53040c1e5ea55280d70494cd8e05e0fe7720e039` |
| `vectors/informative/uri/INF-URI-c05.bin` | `vectors/informative/uri/INF-URI-c05.bin` | `9597778bc8da6991fea0f417e0dcb34483277afa581a623e3e343b20cda51823` |
| `vectors/informative/uri/INF-URI-c05.json` | `vectors/informative/uri/INF-URI-c05.json` | `527ba8dec0b8f3b73097409320a1b6f5bdc425db67d12f146116b305927e81d9` |
| `vectors/informative/uri/INF-URI-c06.bin` | `vectors/informative/uri/INF-URI-c06.bin` | `3c13d6908d1eb4cc565570d8320b75919a23f17f0c5c9e0b26cacacc6289012e` |
| `vectors/informative/uri/INF-URI-c06.json` | `vectors/informative/uri/INF-URI-c06.json` | `3ce4604a70fca7f420e0beff1fae1d121112c8ce19544b1dcc4bf22502666e2a` |
| `vectors/informative/uri/INF-URI-c07.bin` | `vectors/informative/uri/INF-URI-c07.bin` | `7f7ead87c2f62a2be1daca0fa62110fe4cd5907e187ce6447642fe72e07c8df3` |
| `vectors/informative/uri/INF-URI-c07.json` | `vectors/informative/uri/INF-URI-c07.json` | `461902e2aa7a123e90e7f5e5dbcb5c6807ea472e980a0390a24c858c9e69b265` |
| `vectors/informative/uri/INF-URI-c08.bin` | `vectors/informative/uri/INF-URI-c08.bin` | `a139a5720b69e3becc98eda48e5b7389cc4eb5c455f749339a9386b8a8969363` |
| `vectors/informative/uri/INF-URI-c08.json` | `vectors/informative/uri/INF-URI-c08.json` | `ce708138b24a69ff66d024cd6d16a15ee8f8c3975b492182462f113e144f7d71` |
| `vectors/informative/uri/INF-URI-c09.bin` | `vectors/informative/uri/INF-URI-c09.bin` | `c25dc06d70018520f2e9cbeca8e3085dce4809007b479a3ce243dbeb1ea20355` |
| `vectors/informative/uri/INF-URI-c09.json` | `vectors/informative/uri/INF-URI-c09.json` | `40e810e66d1ec6f52511d3b640003d34b19b3b838eca2d2e67ed25856e6b2d11` |
| `vectors/informative/uri/INF-URI-c10.bin` | `vectors/informative/uri/INF-URI-c10.bin` | `aa4327bd0a76eecb42efda7586584dec7c88d7fa64c8bd994d1cc070775b00dd` |
| `vectors/informative/uri/INF-URI-c10.json` | `vectors/informative/uri/INF-URI-c10.json` | `c5778658c1f4636178c702f39f6ef50902e500de735dd29e408a62d261c083b5` |
| `vectors/informative/uri/INF-URI-c11.bin` | `vectors/informative/uri/INF-URI-c11.bin` | `fd18abfd24f5628fae6dfe38a5fc4da1bf289057983be240cfcfbb1955ff926a` |
| `vectors/informative/uri/INF-URI-c11.json` | `vectors/informative/uri/INF-URI-c11.json` | `6f59181be8792d9df6790edd0b52458b8790d42d500d0ef7206cd6771e6196a4` |
| `vectors/informative/uri/INF-URI-c12.bin` | `vectors/informative/uri/INF-URI-c12.bin` | `d3af21287b94286a54bbfefe302f9a74dd94f6c0ba644d33198d62d59ead572f` |
| `vectors/informative/uri/INF-URI-c12.json` | `vectors/informative/uri/INF-URI-c12.json` | `6da7ef83cef782b3b9d74e202b0da0203aff47890399976151e97d0cf94bd15f` |
| `vectors/informative/uri/INF-URI-c13.bin` | `vectors/informative/uri/INF-URI-c13.bin` | `137fb360527518647896624deb98c9c2f66044ae27defe3b045a4a98f1979c88` |
| `vectors/informative/uri/INF-URI-c13.json` | `vectors/informative/uri/INF-URI-c13.json` | `58cc41b364daad8ce94ccbb4e36fd1cb3775c5aee46f2a5befccca1acbe2120a` |
| `vectors/informative/uri/INF-URI-c14.bin` | `vectors/informative/uri/INF-URI-c14.bin` | `51d5fb44e85de5c9ff446a424fb4ee5cb029b4051cfda66d1207f4f9ecd29ed8` |
| `vectors/informative/uri/INF-URI-c14.json` | `vectors/informative/uri/INF-URI-c14.json` | `d76333d0b74298fad0faab082e6b03e00e664dd63c23a3a219968f22f68e8449` |
| `vectors/informative/uri/INF-URI-c15.bin` | `vectors/informative/uri/INF-URI-c15.bin` | `638da465654c6a2ecd78926557e3f43568d5c5fa3c11ea19e886be71cc564614` |
| `vectors/informative/uri/INF-URI-c15.json` | `vectors/informative/uri/INF-URI-c15.json` | `4b3868c835516456e4fd3d9a085a0dea28bcbbe9488e5a3a0517e68ffa4209b0` |
| `vectors/informative/uri/INF-URI-c16.bin` | `vectors/informative/uri/INF-URI-c16.bin` | `ba7b14e10ee1434eecb848fa5d364674e88b8085a45d3037f25e1907deb251b8` |
| `vectors/informative/uri/INF-URI-c16.json` | `vectors/informative/uri/INF-URI-c16.json` | `7853b66ceefb6a3873dda04d2efe6441cd05330a71bec5f3cd038078d4ff6c03` |
| `vectors/informative/uri/INF-URI-c17.bin` | `vectors/informative/uri/INF-URI-c17.bin` | `35368b0dad8c4157d90ebdfbd8e06591a7f4ef3b91e4de3f37bceb4228d71efc` |
| `vectors/informative/uri/INF-URI-c17.json` | `vectors/informative/uri/INF-URI-c17.json` | `65337f582cc657fde1590683654c2fdb88eac28092597a8eac006608055c5ac2` |
| `vectors/informative/uri/INF-URI-c18.bin` | `vectors/informative/uri/INF-URI-c18.bin` | `2fe9c4e5f6124fc8b009f7f8aa0bbf803789ddf3f31a65473fa433e5bed494e2` |
| `vectors/informative/uri/INF-URI-c18.json` | `vectors/informative/uri/INF-URI-c18.json` | `606110f10d11648bb4d045165bfc8d6ee21a8d9cc3d623e65932474e7e50a582` |
| `vectors/informative/uri/INF-URI-c19.bin` | `vectors/informative/uri/INF-URI-c19.bin` | `d06e06c110e5f23e3727b0c24b27db91fd1f27413407e6986cf4ddbd92775dc7` |
| `vectors/informative/uri/INF-URI-c19.json` | `vectors/informative/uri/INF-URI-c19.json` | `8ca649cb6899753c40d247fcf9a6b6bff6496f56393d14eca923daddfa5f9819` |
| `vectors/informative/uri/INF-URI-c20.bin` | `vectors/informative/uri/INF-URI-c20.bin` | `c4f3f4282cd73007ed0b28cfc81f61c5f41ba5e92790a8920f34eb2ffb47d834` |
| `vectors/informative/uri/INF-URI-c20.json` | `vectors/informative/uri/INF-URI-c20.json` | `0e27d0e987174bf5508527c35ddeccc46f5f73a5e2850ef067c98c4956890e69` |
| `vectors/informative/uri/INF-URI-c21.bin` | `vectors/informative/uri/INF-URI-c21.bin` | `f1307a452c6591a973e621c9ace083fd678718d8eb6b4e57bd633153d97bf7ee` |
| `vectors/informative/uri/INF-URI-c21.json` | `vectors/informative/uri/INF-URI-c21.json` | `96f2510b8793c1bd5b6038b8dc6973424737658a92f987ef14a6e864b60feb91` |
| `vectors/informative/uri/INF-URI-c22.bin` | `vectors/informative/uri/INF-URI-c22.bin` | `bc7fa67a4aa982ce22cf4bfd77294edc8fb18fb248a03bb7893113eb73956384` |
| `vectors/informative/uri/INF-URI-c22.json` | `vectors/informative/uri/INF-URI-c22.json` | `f32b67986f5239bc61e077edbf13b4265e89d311c1decfff2bfd39b1353a496b` |
| `vectors/informative/uri/INF-URI-c23.bin` | `vectors/informative/uri/INF-URI-c23.bin` | `66d85f29694730b34cf12ba3070614d1b4017efd0631ff9e54487cdb3d18fbd5` |
| `vectors/informative/uri/INF-URI-c23.json` | `vectors/informative/uri/INF-URI-c23.json` | `c2c37b34e081b93a95ba60b8a5f998eb457aa272f5f123c50b0f96d09ddc1f8a` |
| `vectors/informative/uri/INF-URI-c24.bin` | `vectors/informative/uri/INF-URI-c24.bin` | `885e42eed4dcf3b37f100847ef2a27031e7e97efb4541d6c1c06a32034d678f8` |
| `vectors/informative/uri/INF-URI-c24.json` | `vectors/informative/uri/INF-URI-c24.json` | `07376edf9bebc57a30ffe2723005dcba16dacfa511036b79db5a35cde3d66b39` |
| `vectors/informative/uri/INF-URI-c25.bin` | `vectors/informative/uri/INF-URI-c25.bin` | `958548495ca768f528060f13022da75f3c569660be1984c9f12893b1283a8e50` |
| `vectors/informative/uri/INF-URI-c25.json` | `vectors/informative/uri/INF-URI-c25.json` | `83f9a8de782606695fab6d004617fb57c1aadbaf7b026b6fca467a1bafca2ac3` |
| `vectors/informative/uri/INF-URI-c26.bin` | `vectors/informative/uri/INF-URI-c26.bin` | `27ca4ef6d5beb46112a9f8ab01dd4aeb01751fcc8edb3ce889a86bf19bc5d782` |
| `vectors/informative/uri/INF-URI-c26.json` | `vectors/informative/uri/INF-URI-c26.json` | `5c5c4094bad54ac793f27d2c4c34ffa7f02f8f90f3d3d8dd92c4a767d6536b35` |
| `vectors/informative/uri/README.md` | `vectors/informative/uri/README.md` | `1ada28eb9d3543a14c8ac6611305a545bbb70bfd383dfdfd15e763dd95761a29` |
| `vectors/informative/uri/investigation/cases.json` | `vectors/informative/uri/investigation/cases.json` | `98eafc243c9524e54bc5b892f4e3a4fcbcb8bcbfdce6cbb7a0d642dc41e95bdc` |
| `vectors/informative/uri/investigation/node.json` | `vectors/informative/uri/investigation/node.json` | `a4fd7dac9f1bc9f319ec252cbb99622d0ea37e7ba7ed7dfcb6192ff2146340fc` |
| `vectors/informative/uri/investigation/node.mjs` | `vectors/informative/uri/investigation/node.mjs` | `ea0566ff2bce6af7b3d180cbee1d6c5ad53e7012b3b49c79ddecbb9b3a6b0020` |
| `vectors/informative/uri/investigation/py.json` | `vectors/informative/uri/investigation/py.json` | `3d6c19ecd7859a8a4cc102629a7a305fe3d7c264a78ec641bef3ee2df418c518` |
| `vectors/informative/uri/investigation/py.py` | `vectors/informative/uri/investigation/py.py` | `1286feeb36cc7a3640d330783c513a19d933fd6566ac3e637207fbf7c9eef7fc` |
| `vectors/informative/uri/investigation/rfc3986.mjs` | `vectors/informative/uri/investigation/rfc3986.mjs` | `17c1a45fae4926d789980264d937a7f64fcd9a5f25a570ba6c42360049e90df8` |
| `vectors/informative/uri/verdicts.json` | `vectors/informative/uri/verdicts.json` | `2582f4e35d607d0000899ead10fbcd760b8d444517fba6d0344a770574af9d54` |
| `vectors/informative/zero-extension/INF-ZEXT-1.bin` | `vectors/informative/zero-extension/INF-ZEXT-1.bin` | `d3a2c6dba988387688b09190abd9045bcaa8fba95b1792b5efbfc59662a05874` |
| `vectors/informative/zero-extension/INF-ZEXT-1.json` | `vectors/informative/zero-extension/INF-ZEXT-1.json` | `53f2cf7d459598cbe01200125756f28a4fa363443e47e986c5a174b4b8882c7c` |
| `vectors/informative/zero-extension/INF-ZEXT-2.bin` | `vectors/informative/zero-extension/INF-ZEXT-2.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/informative/zero-extension/INF-ZEXT-2.json` | `vectors/informative/zero-extension/INF-ZEXT-2.json` | `b2799f69c220fe92e53361a9e232ae7384b78a8d28cf8be474ea1bcfa4cd1fc3` |
| `vectors/informative/zero-extension/INF-ZEXT-3.bin` | `vectors/informative/zero-extension/INF-ZEXT-3.bin` | `d3a2c6dba988387688b09190abd9045bcaa8fba95b1792b5efbfc59662a05874` |
| `vectors/informative/zero-extension/INF-ZEXT-3.json` | `vectors/informative/zero-extension/INF-ZEXT-3.json` | `34e2a6f4417379f678684c383be2431d74eca43c1ff83f4bf91e6560ff6a2cdf` |
| `vectors/informative/zero-extension/INF-ZEXT-4.bin` | `vectors/informative/zero-extension/INF-ZEXT-4.bin` | `b20cb6a9f19c0b7c6f70a6b39379d2e099dc987fdb16f352078956bd6b28cc92` |
| `vectors/informative/zero-extension/INF-ZEXT-4.json` | `vectors/informative/zero-extension/INF-ZEXT-4.json` | `c1fe975b7aebf3b8b992740af8f477f598d648e14f722d0e21e40ddc0cf37b14` |
| `vectors/informative/zero-extension/INF-ZEXT-5.bin` | `vectors/informative/zero-extension/INF-ZEXT-5.bin` | `929e7566dc1cb987c19addac9f45ea59089e92821c75ca8f509d54b6e97b4519` |
| `vectors/informative/zero-extension/INF-ZEXT-5.json` | `vectors/informative/zero-extension/INF-ZEXT-5.json` | `4528ba0ec1fcb3f36730b41f5bc471ec0da21f71eae3b07798596140fe3acfe3` |
| `vectors/informative/zero-extension/INF-ZEXT-6.bin` | `vectors/informative/zero-extension/INF-ZEXT-6.bin` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `vectors/informative/zero-extension/INF-ZEXT-6.json` | `vectors/informative/zero-extension/INF-ZEXT-6.json` | `97921acc3f9941e4d11503536979f73de3b8fbf1b081b922363d660e540ef5cc` |
| `vectors/informative/zero-extension/INF-ZEXT-7.bin` | `vectors/informative/zero-extension/INF-ZEXT-7.bin` | `e57a9600ec1bbce0eb7494d90ae3aac2989109ee7268b75f08fe4ffa789b734c` |
| `vectors/informative/zero-extension/INF-ZEXT-7.json` | `vectors/informative/zero-extension/INF-ZEXT-7.json` | `b824330b880718a5f002f183b06bd46223554936dd3a5db8e9de517c44ab156e` |
| `vectors/informative/zero-extension/INF-ZEXT-8.bin` | `vectors/informative/zero-extension/INF-ZEXT-8.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/informative/zero-extension/INF-ZEXT-8.json` | `vectors/informative/zero-extension/INF-ZEXT-8.json` | `94a798dac11cb2912920ad6b87737f25e64068bae6a918dd58cf9f4cb2674bde` |
| `vectors/informative/zero-extension/INF-ZEXT-S1.json` | `vectors/informative/zero-extension/INF-ZEXT-S1.json` | `ebaadae1526ffa030c3638f86e70532de2fb6a73e37e627367309d372104e7a1` |
| `vectors/manifest.json` | `vectors/manifest.json` | `2424f1ef8e5cfa7d91441897449bedbdbad7176494ae1718fb25a00f86429cb2` |
| `vectors/package.json` | `vectors/package.json` | `61851ec614539ff66df538e0aa322f44981c160302c6a2e9ac0fc40c42df79a9` |
| `vectors/payload/A1.bin` | `vectors/payload/A1.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/A1.json` | `vectors/payload/A1.json` | `a421b8a30f2ab56bbf48dffa419fabd180096f5b25160d35b1300b4be0a26314` |
| `vectors/payload/A2a.bin` | `vectors/payload/A2a.bin` | `a180900c00309bac5f799cfe6c8111865a55edd1e9aa4c609ad13fb5728ee1da` |
| `vectors/payload/A2a.json` | `vectors/payload/A2a.json` | `ee90708f2a1a7e3ce09236fe4981d93a53015188dc40f137a58b0f9144a4d9ea` |
| `vectors/payload/A2b.bin` | `vectors/payload/A2b.bin` | `8c0a3acbb13fd540e295d9703133d94415490f6e7b40b42c0297d1de7f050a0a` |
| `vectors/payload/A2b.json` | `vectors/payload/A2b.json` | `091fab99bc11b784ab2cfa16a849b89f4678bf003bd1124a6425f6380c9e0838` |
| `vectors/payload/A3a.bin` | `vectors/payload/A3a.bin` | `cd7f7e83ee1b220fd1d6aa7e50055d00867c4ad4cd80c0f8981c585e5c323744` |
| `vectors/payload/A3a.json` | `vectors/payload/A3a.json` | `4e69d2044eb1c5a423f4c30ca3a54320926d502ac3c147d6dfce46e64e9dff49` |
| `vectors/payload/A3b.bin` | `vectors/payload/A3b.bin` | `99cdaf9989a30fed54fa50d47150fc988348000c32c1143778c2a8b1044d1561` |
| `vectors/payload/A3b.json` | `vectors/payload/A3b.json` | `54c9e02a70781d2ffbddd5fab9b03c04dca912e9b0609e40901cc07a9012f23f` |
| `vectors/payload/A3c.bin` | `vectors/payload/A3c.bin` | `4dd322f9cdaafc2e4d56098520ba3e260b1f9e2e2bb97131fa2795880328cbb1` |
| `vectors/payload/A3c.json` | `vectors/payload/A3c.json` | `4736fde6b3fde65c6c8a6263a08f9d8cc8602a017b5423b7e40c30fbb83669ca` |
| `vectors/payload/A4a.bin` | `vectors/payload/A4a.bin` | `e3da6cf735a8036c85376d45be1bcba7e3061cb04689d76937be15e3906a585f` |
| `vectors/payload/A4a.json` | `vectors/payload/A4a.json` | `b6099c6bc0a6f6deb79c95b3849abc199ba3229a8218740616731ced33fb2cf1` |
| `vectors/payload/A4b.bin` | `vectors/payload/A4b.bin` | `984599d14eca9807c090557d4f3936e10927d1760ba74f3c9d93aa8395e9c870` |
| `vectors/payload/A4b.json` | `vectors/payload/A4b.json` | `55cbf0cb566e78c733383b7aa8acd24b424b0fd6c3b72dbb2303f04f40e9d145` |
| `vectors/payload/A5a.bin` | `vectors/payload/A5a.bin` | `311b96c7009749e50252ff5782f52f2140395e591f17dce6fa909302dfa5b11a` |
| `vectors/payload/A5a.json` | `vectors/payload/A5a.json` | `f3fef659f23dcbe7d1edd0d795aeec40e289c4b66c5a584f2a010f214e09359d` |
| `vectors/payload/A5b.bin` | `vectors/payload/A5b.bin` | `d34424f8bf0b316b778f89c1254064d0b7c50f18608009da3434d1dc2fbac4e6` |
| `vectors/payload/A5b.json` | `vectors/payload/A5b.json` | `37ffe07a86350249f4e5ab64bd422ea8314bbd239c0cda1c720bd114116f4b34` |
| `vectors/payload/A5c.bin` | `vectors/payload/A5c.bin` | `0b101fc180469fc8f6369b144dc7a54e7677eee8062474abe38b1e17bc4ff543` |
| `vectors/payload/A5c.json` | `vectors/payload/A5c.json` | `a5d5ededafcfc8086370bac0507e2f8d1d1e16f82d98afdff2e1bff98dfbd968` |
| `vectors/payload/I1a.bin` | `vectors/payload/I1a.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I1a.json` | `vectors/payload/I1a.json` | `8d442c783d4587c823b27cc4d8c76a99957ba3345c8f7c08d0a3863babab5c73` |
| `vectors/payload/I1b.bin` | `vectors/payload/I1b.bin` | `4b8f8648a9e280d263cf6e9e9437ce74cd28a0ee01c1a90bff5ccc6fa45b3e4a` |
| `vectors/payload/I1b.json` | `vectors/payload/I1b.json` | `e1282a2b87039356c6012b05f85e1adfcafa2c0978a1cc5c615f26480539c313` |
| `vectors/payload/I2a.bin` | `vectors/payload/I2a.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I2a.json` | `vectors/payload/I2a.json` | `d3ca45cd4dfba00f93b8512aad63ca0d2d0b0d2476906bc13cb32083ae567e67` |
| `vectors/payload/I2b.bin` | `vectors/payload/I2b.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I2b.json` | `vectors/payload/I2b.json` | `5d4d35fe9787a982b27ac8d62d0508e8bc03a5a08a8526cb1b38c03b2d572237` |
| `vectors/payload/I3.bin` | `vectors/payload/I3.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I3.json` | `vectors/payload/I3.json` | `9f72dc1fd9cb8b33a2de1bed33221ba721f30cf752e6629a07f83b4d2d0f6e37` |
| `vectors/payload/R1.bin` | `vectors/payload/R1.bin` | `4b8f8648a9e280d263cf6e9e9437ce74cd28a0ee01c1a90bff5ccc6fa45b3e4a` |
| `vectors/payload/R1.json` | `vectors/payload/R1.json` | `f8c781c5b323a1efcc4ee47bb19bbdbd2a424f845a68c6f128c0fb9758d7c695` |
| `vectors/payload/R2a.bin` | `vectors/payload/R2a.bin` | `ff700797fdedbbdea6f6d74b16c1943bb87118db08310d29aac373e3c6101c1b` |
| `vectors/payload/R2a.json` | `vectors/payload/R2a.json` | `0a127097ec9ee6f78a062adc2e9b4984a896fafd5c14443a467be9d8e3e434c6` |
| `vectors/payload/R2b.bin` | `vectors/payload/R2b.bin` | `a641d3527983c2d4b51aae7d270d130ae3f22fbad67f0e42928c303a930047f8` |
| `vectors/payload/R2b.json` | `vectors/payload/R2b.json` | `912ffad05c4ef2de5732f2e3e9d0ff01360696844895da9f66029e5d4433cf92` |
| `vectors/payload/R2c.bin` | `vectors/payload/R2c.bin` | `5402feff6d5135c7e9b9288847d58a1e8410937dcdc276e257e36331baa274a6` |
| `vectors/payload/R2c.json` | `vectors/payload/R2c.json` | `a7802e202b65bf5c46f6405e68a6a8a36670da72e80fa248a0abe8c844705624` |
| `vectors/payload/R2d.bin` | `vectors/payload/R2d.bin` | `7ffa5e5804f92b32d3fdc1c50f2f8c4fdecbbbc52edb55ad17d751bf348f7bdf` |
| `vectors/payload/R2d.json` | `vectors/payload/R2d.json` | `f8c2c450a84635752a22d246ab62bf57c09f3c270b6558d09a8a584b117a9880` |
| `vectors/payload/R2e.bin` | `vectors/payload/R2e.bin` | `391b4394aa40594a92a03e20266a14d93b1c374f894bf8983fa18db1b769dac2` |
| `vectors/payload/R2e.json` | `vectors/payload/R2e.json` | `b8ba29b0df10eaf591c64835e867f8070d1d32ed3cb90e9a01d75a1ef5fcdeac` |
| `vectors/payload/R2f.bin` | `vectors/payload/R2f.bin` | `88f3c531a4537b619ee6e09257e671457abe9fc531ae2742e427977ed348bc4e` |
| `vectors/payload/R2f.json` | `vectors/payload/R2f.json` | `fd50b0a7c4ffba11b6d7c133910930c7f09dede1452d633d27edb11791a17b7c` |
| `vectors/payload/R3a.bin` | `vectors/payload/R3a.bin` | `98a638e2e5a9163529f1f091d4e926bf5a0600398414be19f87cd3a26702bdd1` |
| `vectors/payload/R3a.json` | `vectors/payload/R3a.json` | `0a41e302c81a9e4ca8cf49ab184c516929b74037bc9adc184081fa758cd51d46` |
| `vectors/payload/R3b.bin` | `vectors/payload/R3b.bin` | `a52a9ffe8a92b7a12f83c0e854cbc3e6fb6f1fabb892fd559d9c634cfb2156a4` |
| `vectors/payload/R3b.json` | `vectors/payload/R3b.json` | `afc201e4d075a0fb875392daca4474a4653966179e32992c60d56ac277d73ad2` |
| `vectors/payload/R4a.bin` | `vectors/payload/R4a.bin` | `7015db5e50158e15b05bb22fa29d03f79d48d078511c5a0c7b1d7152de3b11cd` |
| `vectors/payload/R4a.json` | `vectors/payload/R4a.json` | `57294837a69c4aed4777f4eb0b0b127fa91ed6f0e29010107a2ecbc3a3f80360` |
| `vectors/payload/R4b.bin` | `vectors/payload/R4b.bin` | `4d83dc4e2ee2e4592f9ca1973a2e121ae9ab140342448c48d9f867278108d0ef` |
| `vectors/payload/R4b.json` | `vectors/payload/R4b.json` | `323d0b1888d0989995d08d032570b9d6d4422eafc268b8ada35656f0fe2a273e` |
| `vectors/payload/R4c.bin` | `vectors/payload/R4c.bin` | `3d51d4fdbc43f7fce60e864b6a08e9c13c0667d15963c2645db6a8e941aef071` |
| `vectors/payload/R4c.json` | `vectors/payload/R4c.json` | `54585a7310450a46e3396bcfcae729b9ae80a752652542034b879da1ecd9f81d` |
| `vectors/payload/R4d.bin` | `vectors/payload/R4d.bin` | `26c6442afc323d224fada178d38905a0fac07b709a4f2dbcd7fe947b9c72cbba` |
| `vectors/payload/R4d.json` | `vectors/payload/R4d.json` | `eef26864ac479233234252f26439c9fd4a3ad905521bb1453234c4df49092e23` |
| `vectors/payload/R4e.bin` | `vectors/payload/R4e.bin` | `11a26a4de57bf3228b95d91d06e272c1fc7b070807525dc8d60f58f1f5f810d6` |
| `vectors/payload/R4e.json` | `vectors/payload/R4e.json` | `66e68e67a14086f742d3e14dd462034797a00ee021aeeba68d12cb2aac3c3a15` |
| `vectors/payload/R5a.bin` | `vectors/payload/R5a.bin` | `675e39320b7760ab6884730015e1d48352ede42c61c8ec5e51df39184dc7ba14` |
| `vectors/payload/R5a.json` | `vectors/payload/R5a.json` | `c7595093d1abe3bc810ed7e1e6bf6c7a4dcd349cb29a661dfec3a146e13152c2` |
| `vectors/payload/R5b.bin` | `vectors/payload/R5b.bin` | `0b22485ac7b8d19cdbba8d034121f31d3229ecdfa8c036f08389bf5e66fe1f06` |
| `vectors/payload/R5b.json` | `vectors/payload/R5b.json` | `062517529a858b6718775e5326b95f042fc2a7e61ddf3e6d3da5df6198b8cf50` |
| `vectors/payload/R5c.bin` | `vectors/payload/R5c.bin` | `6e7010ea77a40ad199411dae4706766e249a5be1f63cf53ddd74367595275ca2` |
| `vectors/payload/R5c.json` | `vectors/payload/R5c.json` | `9bcbfd3ae756b43e1c80db1734583a0b22ec9567b6db8e9fe6c18710764b5925` |
| `vectors/payload/R5d.bin` | `vectors/payload/R5d.bin` | `0ab49042633e1c2f08f3d7688a2921ed577b4833cff9575a12f7bafa8e2a6c2f` |
| `vectors/payload/R5d.json` | `vectors/payload/R5d.json` | `08ae6cfd8b947a371422509431700fada9482a1554e439d726bdab1e4e9b1d6b` |
| `vectors/payload/R5e.bin` | `vectors/payload/R5e.bin` | `638da465654c6a2ecd78926557e3f43568d5c5fa3c11ea19e886be71cc564614` |
| `vectors/payload/R5e.json` | `vectors/payload/R5e.json` | `0e7c425d34e3c7293487fb1ed93b66099f62f1adf14d0c01e00a4c0edf0c26af` |
| `vectors/payload/R5f.bin` | `vectors/payload/R5f.bin` | `a40c9274e395769b55e6c336f74f50704094939f4de0b64a10ae20d59a88ec9e` |
| `vectors/payload/R5f.json` | `vectors/payload/R5f.json` | `c78d81276ab3df0a21e0f5c2696575980bede2e731539890a4bb9b738fa94d73` |
| `vectors/payload/R5g.bin` | `vectors/payload/R5g.bin` | `5ddba4ee302680f1d6ac00887a90c186eb56cebe21f671fd4359e0636d20fa0b` |
| `vectors/payload/R5g.json` | `vectors/payload/R5g.json` | `cfc860f5e7fd3be7bdfdf1bb3b226527001123ef3eb73acb46cd9a78bdea99dd` |
| `vectors/payload/R5h.bin` | `vectors/payload/R5h.bin` | `083a66bc9f6e42610149b944f16c3c160311ddf5433d4f5551c1fe1e1edb0e83` |
| `vectors/payload/R5h.json` | `vectors/payload/R5h.json` | `79766a2f891c5b10b5e158f6b279cefb10e11981700e34249883f89b9822bb59` |
| `vectors/payload/R6a.bin` | `vectors/payload/R6a.bin` | `da05b2a579d25becefff6bfecf787dcda49de6f24693f9f6f0839f8c57c437eb` |
| `vectors/payload/R6a.json` | `vectors/payload/R6a.json` | `fb9a4ea8b0f217dcb656af7180811de5f71434a8bdb56c545295c907c7e557a1` |
| `vectors/payload/R6b.bin` | `vectors/payload/R6b.bin` | `99bfcb77feda44689a180a3580e03251b2af0177085a015f5ffc10c54b229c10` |
| `vectors/payload/R6b.json` | `vectors/payload/R6b.json` | `2511b19f218bd4facefd8fe6b282a87e286015406cffa826733a760c535ba206` |
| `vectors/schema/manifest.schema.json` | `vectors/schema/manifest.schema.json` | `f7115dd439220a2be2ad245f2f2b2363623d184c56715c53da48e8ebf5b08345` |
| `vectors/schema/payload.schema.json` | `vectors/schema/payload.schema.json` | `7116c41146700fc2f09265251e4f3a5e6881c3b4c349c8b610ab78dfe4d90891` |
| `vectors/schema/runner.schema.json` | `vectors/schema/runner.schema.json` | `4fa74122fa96b5a786e1235d4e2cc89cab838e9834c2de4ef246a3bf3ebbab8b` |
| `vectors/schema/state.schema.json` | `vectors/schema/state.schema.json` | `4a1e240348442989184cdfcd74445ced1f49ed928d0b561f306fc517244e703c` |
| `vectors/state/A3a-state.json` | `vectors/state/A3a-state.json` | `0e1b326eeb67f3d6c8e898837353d37bdc60b6a384f8ad792c051fc57079a5a1` |
| `vectors/state/A4b-state.json` | `vectors/state/A4b-state.json` | `9c8828a319f07ece9a20b72e4b20f1db65a6d48570fde8e889739cb13d681c14` |
| `vectors/state/A5a-state.json` | `vectors/state/A5a-state.json` | `a381638246a0accc589a9c28d437ec9ebe4d5ec4cbd973d8620c64e212c680a5` |
| `vectors/state/A5b-state.json` | `vectors/state/A5b-state.json` | `832448fa25da17d2713a1bf6edeea6ec29c44ea6db26fdb477cfe76f7a933f63` |
| `vectors/state/A5c-state.json` | `vectors/state/A5c-state.json` | `39ea6bda96fb6023d6b0e19395ba0bc6294fadd87c97cbf62cd03e3530de6548` |
| `vectors/state/S1a.json` | `vectors/state/S1a.json` | `9a483b1bbd479cf62ac9a30efe7eb719f80ac10075009de919b476994de14700` |
| `vectors/state/S1b.json` | `vectors/state/S1b.json` | `5f9181a1d52fde74783fc8929841387e4ef9f71246d3b7a37403d7c9d682f115` |
| `vectors/state/S2a.json` | `vectors/state/S2a.json` | `167f24319b93a6227ec81e0f185214ce0b3a7796aa13e527b78c697587306f96` |
| `vectors/state/S2b.json` | `vectors/state/S2b.json` | `cf48159a9c3e9b7653f01f4ca3fcd8da749f54de339692a1f4602294fdbb1b25` |
| `vectors/state/S3a.json` | `vectors/state/S3a.json` | `f57ce9edbc47ae2f8573ba0d8f466ae1a5af6c7d47ca98cfe20ed4e15d2eb70e` |
| `vectors/state/S3b.json` | `vectors/state/S3b.json` | `bb34171e314061188447e9e98b4db77cb6a4002501617650403dd113c8a08b2d` |
| `vectors/state/S3c.json` | `vectors/state/S3c.json` | `734d99469c6206fe0a8bea31dc6d3b6604cb653906362c7e3bf815585a9aadca` |
| `vectors/state/S3d.json` | `vectors/state/S3d.json` | `46f7c8798994fe54c67e3a8e019437f861e017c86807a6758a8c90a2ee74d6a5` |
| `vectors/state/S4a.json` | `vectors/state/S4a.json` | `a74f626d4de26f462e4549371d4f5305cf6e78c57c38d735743749f80bc02b90` |
| `vectors/state/S4b.json` | `vectors/state/S4b.json` | `7341d5d386d508147f53e4f71eed35244f67880d4f3851aec45bcd3d00e9c269` |
| `vectors/state/S5a.json` | `vectors/state/S5a.json` | `0fca3b48dc16ff012fcaafd86ad5ec8a695596940df3090f95712b548c26b7cf` |
| `vectors/state/S5b.json` | `vectors/state/S5b.json` | `d72187b05c833c2cebb95e7338ec46c67a248f74e00b7c0d3278ef65a86f1b4c` |
| `vectors/state/S5c.json` | `vectors/state/S5c.json` | `220d99eb67fceefebdd6b3f306745a089d06810ea66dcc67046ad0b8e2748cbf` |
| `vectors/state/S6a.json` | `vectors/state/S6a.json` | `6fb43febb62d913acf38397f29b3345760c113463a31e7d19dedfc982795a643` |
| `vectors/state/S6b.json` | `vectors/state/S6b.json` | `9f0aa75a067cb32362bab46a2a4f10d9e7cde6b8038b9dc22a933b36275fb827` |
| `vectors/state/S7a.json` | `vectors/state/S7a.json` | `0ea37f8bb78e54fb61f43b99948b00ff511f29220ea0b88340467f7bbe1a6ae3` |
| `vectors/state/S7b.json` | `vectors/state/S7b.json` | `1c904dfe26073c116f75598ecf8ca887d6dd10c16410c9a88bac1c0f87e3a9e8` |
| `vectors/state/S8.json` | `vectors/state/S8.json` | `e5c9d4b5b0a27094ec6a6f92cc20dabba044276c08d269ca79c436bacb91cdb6` |
| `vectors/state/S9a.json` | `vectors/state/S9a.json` | `21b5964daa66130aeddca05002b1070364d46e40d196a1ac6f46983f20356e21` |
| `vectors/state/S9b.json` | `vectors/state/S9b.json` | `4fc3f711118df441032e1dec0d4e0f0265f225bd2fd23a28ff2e2ccd04236369` |
| `vectors/state/S9c.json` | `vectors/state/S9c.json` | `ebb94b9edc19776184ec6f0fc70ee2d52d7f30362cc6e5859d701b300e4b4c45` |
| `vectors/state/S9d.json` | `vectors/state/S9d.json` | `a720036550f339bb501f84060fb2e1fa19714091bf91c56c3d74ebff18352e68` |
| `vectors/tools/common.ts` | `vectors/tools/common.ts` | `8788eece1731e864360e5eb8e8318dc5e4eb2e24064dc5a4f19a740a570f3959` |
| `vectors/tools/compare.ts` | `vectors/tools/compare.ts` | `d47806995e9cdbc8f4c2f2b59ca8ccd4f26e5abb759f27a7e05d0cecfe36423e` |
| `vectors/tools/run.ts` | `vectors/tools/run.ts` | `7599711a9c28f5a34b5157cb7d4583afd793e0304e3911261b48df845b237e6c` |
| `vectors/tools/runner-core.ts` | `vectors/tools/runner-core.ts` | `83cea1d295e4623622746ef20b611b6124a552434326a12585a1dd75b17cb782` |
| `vectors/tsconfig.json` | `vectors/tsconfig.json` | `cb6faae9b1e50f96a5022c3c3deea257b630f53cb49e8cd2417746c36bc7a810` |

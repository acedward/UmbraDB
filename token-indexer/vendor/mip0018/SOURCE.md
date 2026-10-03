# Vendored MIP-0018 reference parts — provenance

Every file in this directory (except this `SOURCE.md`) is a **verbatim** copy of a file of the MIP-0018 reference
implementation at the pinned commit below. None of them is edited; a change upstream is re-vendored deliberately
(copy the files again, update this table). `token-indexer/test/mip0018-provenance.test.ts` recomputes every SHA-256
below in CI and fails on any modified, missing or unlisted file.

| Field | Value |
|---|---|
| Upstream | `https://github.com/midnight-experiments/mip-0018.git`, branch `main` |
| Pinned at | **`daec1f19747b09f4e245885ab0dd9ecc789a82ce`** ("toolchain.json: Prettier formatting", 2026-10-02) |
| License | Apache-2.0 (upstream `LICENSE` and `NOTICE` vendored next to this file; UmbraDB is Apache-2.0 too) |
| MIP text the upstream files are written against | MIP-0018 PR #340 @ `78ecbb4b1ba57371e84fe45f705991ab7b996a61` |
| MIP text UmbraDB implements | MIP-0018 PR #340 head **`274a84f221bcfc17e4b73e2c8b32fd8c028ea092`** (per-key tombstones). The two texts define the same payload format, checks, value types and event name, so the codec classifies events exactly as `274a84f` requires; they differ in the tombstone rule, the S1/S3/S4/S9 tests and the grouping wording |
| Vendored on | 2026-10-02 |

Vendored parts:

- `codec/` — the dependency-free codec (`packages/codec`: `package.json`, `README.md`, `tsconfig.json`, `src/`).
  UmbraDB classifies and decodes every observed `Misc` event with it.
- `vectors/` — the vectors (`manifest.json`, `SHA256SUMS`, `README.md`, `schema/`, `payload/`, `state/`,
  `informative/`: 110 vectors, 67 normative and 43 informative) and the runner (`tools/run.ts` with the three files it
  imports: `runner-core.ts`, `compare.ts`, `common.ts`), plus `package.json`/`tsconfig.json` as upstream has them.
  The runner checks `SHA256SUMS` itself before every run (197 entries). The upstream `package.json` exports
  `./validate` (`tools/validate.ts`), which is not vendored; nothing here resolves that package name.

What is **not** vendored: the reference consumer (`packages/consumer`, whole-identity tombstones of `78ecbb4`), the
codec's own unit tests (they import `@mip0018/vectors` by package name, which this path-import layout does not
resolve; the codec is exercised here through every payload vector instead), the vectors' own tests, the generator
(`tools/generate.ts`), the schema validator (`tools/validate.ts`, needs `ajv`) and `tools/bytes.ts` (used only by
those). UmbraDB's state rules (per-key tombstones) are its own code in `token-indexer/mip0018/state.ts`; UmbraDB's own
`274a84f` versions of the eight state vectors whose expected results differ between the two texts (S1a, S3a–S3d,
S4a/S4b, S9d) live in `token-indexer/mip0018/vectors-umbradb/` with their own provenance, and are run instead of the
vendored files with the same ids.

How UmbraDB uses the files: plain path imports (`token-indexer/vendor/mip0018/codec/src/index.ts`), no npm `file:`
dependency; the root `tsconfig.json` sets `allowImportingTsExtensions` (it is `noEmit`) so `tsc` accepts the `.ts`
specifiers the upstream sources use. The runner is started as upstream documents it,
`node token-indexer/vendor/mip0018/vectors/tools/run.ts --consumer "<UmbraDB adapter>" …` (Node ≥ 24 strips the types).

## Files

| This directory | Upstream path at the pin | SHA-256 |
|---|---|---|
| `LICENSE` | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `NOTICE` | `NOTICE` | `7dfa652b7aee31524aa22622276d56cc5f96faf191ee353c5510aafd8af6e0f7` |
| `codec/README.md` | `packages/codec/README.md` | `9dab8be79c93ef5cfbb557fae7bbaf18225d1c69950ac1fb19d062b452547954` |
| `codec/package.json` | `packages/codec/package.json` | `f5d7eb61889c7c8a330065c2196c7cb65072433258c342bba0412975f675bac5` |
| `codec/src/classify.ts` | `packages/codec/src/classify.ts` | `57821aadf0af8772909408c601107f142ea5a7d19f3b2988fd23393b29049cf6` |
| `codec/src/constants.ts` | `packages/codec/src/constants.ts` | `7520efd857a6035752e9e8139fdbef11fc1ade984c820b9f240549ed60dc7274` |
| `codec/src/decode.ts` | `packages/codec/src/decode.ts` | `d9cee4a9b551448e3ffb90adedf8869e0749cf4b4350e97093b3d615363ffc41` |
| `codec/src/encode.ts` | `packages/codec/src/encode.ts` | `1ba99d64ba25b1b3b6473e29c15ed71e2307524f1fd6c75979c79b8caeb88b86` |
| `codec/src/hex.ts` | `packages/codec/src/hex.ts` | `7ad2914d8bb983dde3ccc00edb05955afa948f9108894b57ae586686d4ab2e01` |
| `codec/src/index.ts` | `packages/codec/src/index.ts` | `e2487ca5a1dd4983df9e372fbcdb4f34e983e709380abdcd11481ba9c016bf17` |
| `codec/src/internal.ts` | `packages/codec/src/internal.ts` | `8d8631bf553b7d5f65c768b5fe33d0083cd559b0db7e3cf111ee77b983125272` |
| `codec/src/rules.ts` | `packages/codec/src/rules.ts` | `a3e92a68d5e859ca38016e7091e2e244607f0268c3c39674d4de4946dcab595a` |
| `codec/src/uri.ts` | `packages/codec/src/uri.ts` | `612e56954c17995e4ca98e865e4865d9bbfdbd6c5a9de11fc2a168d055174829` |
| `codec/src/values.ts` | `packages/codec/src/values.ts` | `5e20c4e166e1960c929a290bdf812971fe478201649fbcb5d8a1fa8610299e79` |
| `codec/tsconfig.json` | `packages/codec/tsconfig.json` | `1443a43102572e64d3bc659d5f5984a4fce3b087bdfac72a8d6bb4b55b3139ec` |
| `vectors/README.md` | `vectors/README.md` | `11535c2e60660f2219544c812e58c8c34d17f60eda1a494724771eec64fc94d0` |
| `vectors/SHA256SUMS` | `vectors/SHA256SUMS` | `6cb0d4ca184b253780cd024dff8205e7698adcf24c13b48fd47cd26acf97c9f1` |
| `vectors/informative/state/INF-COMMON-1.json` | `vectors/informative/state/INF-COMMON-1.json` | `8258c1f592c2553810b64ea8103d41624b30a33236008a263c1c185e1ba379a8` |
| `vectors/informative/state/INF-STD-1.json` | `vectors/informative/state/INF-STD-1.json` | `b40a183467498050c43df57faa72452367c724f42d9c8253b3bf2ac035a9265a` |
| `vectors/informative/state/INF-STD-2.json` | `vectors/informative/state/INF-STD-2.json` | `7ded7700c323f11e06b0f51257a28118d0c5534bfd342b439d1984f2c1888036` |
| `vectors/informative/state/INF-STD-3.json` | `vectors/informative/state/INF-STD-3.json` | `57d3e1a17f434b001a8edf13afe9d37798f3816d721f6e76e534ec6b57dc8a89` |
| `vectors/informative/state/INF-STD-4.json` | `vectors/informative/state/INF-STD-4.json` | `8f0cb31d64b45d720c89dd81b1a3bf8e65dbef2d8d39fc8c4fbb4c962cac5ddc` |
| `vectors/informative/state/INF-STD-5.json` | `vectors/informative/state/INF-STD-5.json` | `50ba6ef6d7da197abe58e182cfc470efbc4fdb99ea0a3e8a0a92f9c35a64202d` |
| `vectors/informative/state/INF-STD-6.json` | `vectors/informative/state/INF-STD-6.json` | `9fa6d3e222ff26e3c121dbabf918ceed807d86d77cc6d01cb1c32e29c392676e` |
| `vectors/informative/state/INF-STD-7.json` | `vectors/informative/state/INF-STD-7.json` | `b08d97da2e0329aa33aca18e1782d9f63150aa498686536e69d353877cad9add` |
| `vectors/informative/uri/INF-URI-c01.bin` | `vectors/informative/uri/INF-URI-c01.bin` | `680ba46bb882705fe965366ebdd658dd09cb6729bc06bb12ae45efd9c7cab00d` |
| `vectors/informative/uri/INF-URI-c01.json` | `vectors/informative/uri/INF-URI-c01.json` | `f562cfe6498df700104c051616903c9ad8c79f1e4b7262e49e0e74a839b0eb9b` |
| `vectors/informative/uri/INF-URI-c02.bin` | `vectors/informative/uri/INF-URI-c02.bin` | `37b24904c2a41ec0ae8a996bde9877f79c7017ef0b77eec796f0082809a340d6` |
| `vectors/informative/uri/INF-URI-c02.json` | `vectors/informative/uri/INF-URI-c02.json` | `dc2eef6f8c1972889a54af093c8c08aa39ae5721d885521b1ca7009f42281796` |
| `vectors/informative/uri/INF-URI-c03.bin` | `vectors/informative/uri/INF-URI-c03.bin` | `2e0ca2b06c0c2b5b943f02c89331f60083676a86ef38c21698662b9be707addc` |
| `vectors/informative/uri/INF-URI-c03.json` | `vectors/informative/uri/INF-URI-c03.json` | `b6c0e28920b1328142c346e32cd24b0a788e134fdb55f3ee75a7eb9b3fdddfd9` |
| `vectors/informative/uri/INF-URI-c04.bin` | `vectors/informative/uri/INF-URI-c04.bin` | `eb77460513bca4267fcc4f17c6dc85cde619661006ecebf87076b5cbf33e6fb9` |
| `vectors/informative/uri/INF-URI-c04.json` | `vectors/informative/uri/INF-URI-c04.json` | `421d007d99ef4f5f53544edca8dec6db6373a8d38427b2b8c0d6399bc525e092` |
| `vectors/informative/uri/INF-URI-c05.bin` | `vectors/informative/uri/INF-URI-c05.bin` | `9597778bc8da6991fea0f417e0dcb34483277afa581a623e3e343b20cda51823` |
| `vectors/informative/uri/INF-URI-c05.json` | `vectors/informative/uri/INF-URI-c05.json` | `6973a965775ad0e1e0437c2cdfbe2a5c01d8ff7c2dfe72bab11d99c6ffc24084` |
| `vectors/informative/uri/INF-URI-c06.bin` | `vectors/informative/uri/INF-URI-c06.bin` | `3c13d6908d1eb4cc565570d8320b75919a23f17f0c5c9e0b26cacacc6289012e` |
| `vectors/informative/uri/INF-URI-c06.json` | `vectors/informative/uri/INF-URI-c06.json` | `cbe854398fe30bf88ba68041b166a996b1bfb6f0b87fb3df93b801d88313fdfa` |
| `vectors/informative/uri/INF-URI-c07.bin` | `vectors/informative/uri/INF-URI-c07.bin` | `7f7ead87c2f62a2be1daca0fa62110fe4cd5907e187ce6447642fe72e07c8df3` |
| `vectors/informative/uri/INF-URI-c07.json` | `vectors/informative/uri/INF-URI-c07.json` | `719c60a3020de289ef3177d8e0c8066653ae9f8972436ee4889415fdf84e179b` |
| `vectors/informative/uri/INF-URI-c08.bin` | `vectors/informative/uri/INF-URI-c08.bin` | `a139a5720b69e3becc98eda48e5b7389cc4eb5c455f749339a9386b8a8969363` |
| `vectors/informative/uri/INF-URI-c08.json` | `vectors/informative/uri/INF-URI-c08.json` | `5fc6fda61066d56e26e5e54a5b67353ccd276718b253dbc0c0587f5ed58bd4ec` |
| `vectors/informative/uri/INF-URI-c09.bin` | `vectors/informative/uri/INF-URI-c09.bin` | `c25dc06d70018520f2e9cbeca8e3085dce4809007b479a3ce243dbeb1ea20355` |
| `vectors/informative/uri/INF-URI-c09.json` | `vectors/informative/uri/INF-URI-c09.json` | `ec23127645fe2c33713a725f7c60ae3af4cf48c5b693c1ac892d0ffe9a41850b` |
| `vectors/informative/uri/INF-URI-c10.bin` | `vectors/informative/uri/INF-URI-c10.bin` | `aa4327bd0a76eecb42efda7586584dec7c88d7fa64c8bd994d1cc070775b00dd` |
| `vectors/informative/uri/INF-URI-c10.json` | `vectors/informative/uri/INF-URI-c10.json` | `e1983678755999e0c94dc795162e4692f5133c85a7b603b1cc34675a995a8fe9` |
| `vectors/informative/uri/INF-URI-c11.bin` | `vectors/informative/uri/INF-URI-c11.bin` | `fd18abfd24f5628fae6dfe38a5fc4da1bf289057983be240cfcfbb1955ff926a` |
| `vectors/informative/uri/INF-URI-c11.json` | `vectors/informative/uri/INF-URI-c11.json` | `e7be4a591873bb1187caaa6ffe1d38a39ceb7164608d958c415cf9d748eedf4e` |
| `vectors/informative/uri/INF-URI-c12.bin` | `vectors/informative/uri/INF-URI-c12.bin` | `d3af21287b94286a54bbfefe302f9a74dd94f6c0ba644d33198d62d59ead572f` |
| `vectors/informative/uri/INF-URI-c12.json` | `vectors/informative/uri/INF-URI-c12.json` | `ece05f89c0050f311c2a92b619de11fa9dc43fba4bb9d5f3b7db7ff73d6f82d7` |
| `vectors/informative/uri/INF-URI-c13.bin` | `vectors/informative/uri/INF-URI-c13.bin` | `137fb360527518647896624deb98c9c2f66044ae27defe3b045a4a98f1979c88` |
| `vectors/informative/uri/INF-URI-c13.json` | `vectors/informative/uri/INF-URI-c13.json` | `a530d97f37683b5d02126c3743ef726d9e9a2a124a08ae3f18f00a23ac220266` |
| `vectors/informative/uri/INF-URI-c14.bin` | `vectors/informative/uri/INF-URI-c14.bin` | `51d5fb44e85de5c9ff446a424fb4ee5cb029b4051cfda66d1207f4f9ecd29ed8` |
| `vectors/informative/uri/INF-URI-c14.json` | `vectors/informative/uri/INF-URI-c14.json` | `bcebcdaf0c63007dc1ee35270050d3e8dc45c038c0468334bfcbc1403004e225` |
| `vectors/informative/uri/INF-URI-c15.bin` | `vectors/informative/uri/INF-URI-c15.bin` | `638da465654c6a2ecd78926557e3f43568d5c5fa3c11ea19e886be71cc564614` |
| `vectors/informative/uri/INF-URI-c15.json` | `vectors/informative/uri/INF-URI-c15.json` | `e85d22dde71cef7371d7df55b702f7b389e15196dd3d0ebaaefacdcecb11dd44` |
| `vectors/informative/uri/INF-URI-c16.bin` | `vectors/informative/uri/INF-URI-c16.bin` | `ba7b14e10ee1434eecb848fa5d364674e88b8085a45d3037f25e1907deb251b8` |
| `vectors/informative/uri/INF-URI-c16.json` | `vectors/informative/uri/INF-URI-c16.json` | `ecaedd18df977e5a5a0210a81ab3a922c0cd96e2914e0f94e8ee8b537f9139db` |
| `vectors/informative/uri/INF-URI-c17.bin` | `vectors/informative/uri/INF-URI-c17.bin` | `35368b0dad8c4157d90ebdfbd8e06591a7f4ef3b91e4de3f37bceb4228d71efc` |
| `vectors/informative/uri/INF-URI-c17.json` | `vectors/informative/uri/INF-URI-c17.json` | `c4c5585522436d05540d644f6abdd07aa08974a6c344744633e445852aa98103` |
| `vectors/informative/uri/INF-URI-c18.bin` | `vectors/informative/uri/INF-URI-c18.bin` | `2fe9c4e5f6124fc8b009f7f8aa0bbf803789ddf3f31a65473fa433e5bed494e2` |
| `vectors/informative/uri/INF-URI-c18.json` | `vectors/informative/uri/INF-URI-c18.json` | `614e621ad2a0f50c537eaf77469d044759a6cb1cfa272bfed5d540ebe5af6839` |
| `vectors/informative/uri/INF-URI-c19.bin` | `vectors/informative/uri/INF-URI-c19.bin` | `d06e06c110e5f23e3727b0c24b27db91fd1f27413407e6986cf4ddbd92775dc7` |
| `vectors/informative/uri/INF-URI-c19.json` | `vectors/informative/uri/INF-URI-c19.json` | `9d8836e2a6bc9c1f9bddbcfb9a17ebf15579bd85b1cc0d840e5d4eef09f29cce` |
| `vectors/informative/uri/INF-URI-c20.bin` | `vectors/informative/uri/INF-URI-c20.bin` | `c4f3f4282cd73007ed0b28cfc81f61c5f41ba5e92790a8920f34eb2ffb47d834` |
| `vectors/informative/uri/INF-URI-c20.json` | `vectors/informative/uri/INF-URI-c20.json` | `240d33dd35fe19a7af78a949419b8aadceb8f00a16312a5257bd2b93e23bab10` |
| `vectors/informative/uri/INF-URI-c21.bin` | `vectors/informative/uri/INF-URI-c21.bin` | `f1307a452c6591a973e621c9ace083fd678718d8eb6b4e57bd633153d97bf7ee` |
| `vectors/informative/uri/INF-URI-c21.json` | `vectors/informative/uri/INF-URI-c21.json` | `15d60a311ff2e6fa1b2a1ac6c5963da5acd783acb206ef72ff1a19f78f2fd2ab` |
| `vectors/informative/uri/INF-URI-c22.bin` | `vectors/informative/uri/INF-URI-c22.bin` | `bc7fa67a4aa982ce22cf4bfd77294edc8fb18fb248a03bb7893113eb73956384` |
| `vectors/informative/uri/INF-URI-c22.json` | `vectors/informative/uri/INF-URI-c22.json` | `cefb23aca937d4cedab64036295feeb62315e8c57c789e81ff1daf09894b1801` |
| `vectors/informative/uri/INF-URI-c23.bin` | `vectors/informative/uri/INF-URI-c23.bin` | `66d85f29694730b34cf12ba3070614d1b4017efd0631ff9e54487cdb3d18fbd5` |
| `vectors/informative/uri/INF-URI-c23.json` | `vectors/informative/uri/INF-URI-c23.json` | `b1470f67fa3be56ab9c50c65ba2ebffe08a102dccb8ad8c9c4996a2644e67862` |
| `vectors/informative/uri/INF-URI-c24.bin` | `vectors/informative/uri/INF-URI-c24.bin` | `885e42eed4dcf3b37f100847ef2a27031e7e97efb4541d6c1c06a32034d678f8` |
| `vectors/informative/uri/INF-URI-c24.json` | `vectors/informative/uri/INF-URI-c24.json` | `f61b2c82b6e6deb52f1fbb44aee4e3d2bd3799f530c057c24c104aaf206af97f` |
| `vectors/informative/uri/INF-URI-c25.bin` | `vectors/informative/uri/INF-URI-c25.bin` | `958548495ca768f528060f13022da75f3c569660be1984c9f12893b1283a8e50` |
| `vectors/informative/uri/INF-URI-c25.json` | `vectors/informative/uri/INF-URI-c25.json` | `455939354fb4bbd9d3dcf78c42b6c349b9611175bddf325e47e53e12e508b562` |
| `vectors/informative/uri/INF-URI-c26.bin` | `vectors/informative/uri/INF-URI-c26.bin` | `27ca4ef6d5beb46112a9f8ab01dd4aeb01751fcc8edb3ce889a86bf19bc5d782` |
| `vectors/informative/uri/INF-URI-c26.json` | `vectors/informative/uri/INF-URI-c26.json` | `2f3d38c4df7c5a0f6eb41f73b723245ac12de94c9b681457728276937e840bde` |
| `vectors/informative/uri/README.md` | `vectors/informative/uri/README.md` | `76718d652d5a17a41fd86e779b5bafb13e27d6b838e19575ca639150cb952c28` |
| `vectors/informative/uri/investigation/cases.json` | `vectors/informative/uri/investigation/cases.json` | `98eafc243c9524e54bc5b892f4e3a4fcbcb8bcbfdce6cbb7a0d642dc41e95bdc` |
| `vectors/informative/uri/investigation/node.json` | `vectors/informative/uri/investigation/node.json` | `a4fd7dac9f1bc9f319ec252cbb99622d0ea37e7ba7ed7dfcb6192ff2146340fc` |
| `vectors/informative/uri/investigation/node.mjs` | `vectors/informative/uri/investigation/node.mjs` | `ea0566ff2bce6af7b3d180cbee1d6c5ad53e7012b3b49c79ddecbb9b3a6b0020` |
| `vectors/informative/uri/investigation/py.json` | `vectors/informative/uri/investigation/py.json` | `3d6c19ecd7859a8a4cc102629a7a305fe3d7c264a78ec641bef3ee2df418c518` |
| `vectors/informative/uri/investigation/py.py` | `vectors/informative/uri/investigation/py.py` | `1286feeb36cc7a3640d330783c513a19d933fd6566ac3e637207fbf7c9eef7fc` |
| `vectors/informative/uri/investigation/rfc3986.mjs` | `vectors/informative/uri/investigation/rfc3986.mjs` | `17c1a45fae4926d789980264d937a7f64fcd9a5f25a570ba6c42360049e90df8` |
| `vectors/informative/uri/verdicts.json` | `vectors/informative/uri/verdicts.json` | `dd7be43ff772878579ea22945b2543987401ea0de4fba32ad5e60424c155c8c9` |
| `vectors/informative/zero-extension/INF-ZEXT-1.bin` | `vectors/informative/zero-extension/INF-ZEXT-1.bin` | `d3a2c6dba988387688b09190abd9045bcaa8fba95b1792b5efbfc59662a05874` |
| `vectors/informative/zero-extension/INF-ZEXT-1.json` | `vectors/informative/zero-extension/INF-ZEXT-1.json` | `e3e1227faf5e424e7d17d4498e6e1e7d604600b336d2f6825407f2ada2233a11` |
| `vectors/informative/zero-extension/INF-ZEXT-2.bin` | `vectors/informative/zero-extension/INF-ZEXT-2.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/informative/zero-extension/INF-ZEXT-2.json` | `vectors/informative/zero-extension/INF-ZEXT-2.json` | `1a35cf7d464d7c9d910b4e902284ea9e7174966cac7562c4a96d6b06c997cb0d` |
| `vectors/informative/zero-extension/INF-ZEXT-3.bin` | `vectors/informative/zero-extension/INF-ZEXT-3.bin` | `d3a2c6dba988387688b09190abd9045bcaa8fba95b1792b5efbfc59662a05874` |
| `vectors/informative/zero-extension/INF-ZEXT-3.json` | `vectors/informative/zero-extension/INF-ZEXT-3.json` | `30bc919471c3dd73e4ff54c6f7b6447fb6a06d6e06ffe7f333a9c26248183c9f` |
| `vectors/informative/zero-extension/INF-ZEXT-4.bin` | `vectors/informative/zero-extension/INF-ZEXT-4.bin` | `b20cb6a9f19c0b7c6f70a6b39379d2e099dc987fdb16f352078956bd6b28cc92` |
| `vectors/informative/zero-extension/INF-ZEXT-4.json` | `vectors/informative/zero-extension/INF-ZEXT-4.json` | `3967c8da30aa5269939c603fcae5a38fc114dcf47dcb7adef004bc7be15a33cd` |
| `vectors/informative/zero-extension/INF-ZEXT-5.bin` | `vectors/informative/zero-extension/INF-ZEXT-5.bin` | `929e7566dc1cb987c19addac9f45ea59089e92821c75ca8f509d54b6e97b4519` |
| `vectors/informative/zero-extension/INF-ZEXT-5.json` | `vectors/informative/zero-extension/INF-ZEXT-5.json` | `6b43218b03dab52b70eefa6d8be73d47e198285734d98584bd5ab533ff589c4f` |
| `vectors/informative/zero-extension/INF-ZEXT-6.bin` | `vectors/informative/zero-extension/INF-ZEXT-6.bin` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `vectors/informative/zero-extension/INF-ZEXT-6.json` | `vectors/informative/zero-extension/INF-ZEXT-6.json` | `21707d7a81a584273f9cbe024d77c9f237c720f422bff507700529e4593536e4` |
| `vectors/informative/zero-extension/INF-ZEXT-7.bin` | `vectors/informative/zero-extension/INF-ZEXT-7.bin` | `e57a9600ec1bbce0eb7494d90ae3aac2989109ee7268b75f08fe4ffa789b734c` |
| `vectors/informative/zero-extension/INF-ZEXT-7.json` | `vectors/informative/zero-extension/INF-ZEXT-7.json` | `21ae8bba637018ffb8f308a22d123a41a97f112b2830fb059efb3b04937d9594` |
| `vectors/informative/zero-extension/INF-ZEXT-8.bin` | `vectors/informative/zero-extension/INF-ZEXT-8.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/informative/zero-extension/INF-ZEXT-8.json` | `vectors/informative/zero-extension/INF-ZEXT-8.json` | `49ca2292fd3a14a157da0cdd661430b2229e0fb6dda08513a26a391e5c0496ab` |
| `vectors/informative/zero-extension/INF-ZEXT-S1.json` | `vectors/informative/zero-extension/INF-ZEXT-S1.json` | `a00cc17765fb7f4cf066e1ab3fdd8e0dc5ccb06d28d9615c30205eda40c66f7c` |
| `vectors/manifest.json` | `vectors/manifest.json` | `c9bef07039fcf5cf0b4dbe24cc68ef75f3d955d3302292cb9254802ae665cba8` |
| `vectors/package.json` | `vectors/package.json` | `61851ec614539ff66df538e0aa322f44981c160302c6a2e9ac0fc40c42df79a9` |
| `vectors/payload/A1.bin` | `vectors/payload/A1.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/A1.json` | `vectors/payload/A1.json` | `50679b447682c11a7f9b5f7a9ac844476bf2be0d41bd8ab2d3465d0e25426e57` |
| `vectors/payload/A2a.bin` | `vectors/payload/A2a.bin` | `a180900c00309bac5f799cfe6c8111865a55edd1e9aa4c609ad13fb5728ee1da` |
| `vectors/payload/A2a.json` | `vectors/payload/A2a.json` | `90d7da6d473b7155e8d8c5a941730c4ba91ee2ba56335347460d0ad90bd2cefc` |
| `vectors/payload/A2b.bin` | `vectors/payload/A2b.bin` | `8c0a3acbb13fd540e295d9703133d94415490f6e7b40b42c0297d1de7f050a0a` |
| `vectors/payload/A2b.json` | `vectors/payload/A2b.json` | `4da3b0500c45d630ecd86f7924555defcf9af7da13e37fef1455c9f6be04a7bb` |
| `vectors/payload/A3a.bin` | `vectors/payload/A3a.bin` | `cd7f7e83ee1b220fd1d6aa7e50055d00867c4ad4cd80c0f8981c585e5c323744` |
| `vectors/payload/A3a.json` | `vectors/payload/A3a.json` | `401fb05fed6429a973c8705e7b9aa43effc66ba2caddc724eaf68a9453ff52c8` |
| `vectors/payload/A3b.bin` | `vectors/payload/A3b.bin` | `99cdaf9989a30fed54fa50d47150fc988348000c32c1143778c2a8b1044d1561` |
| `vectors/payload/A3b.json` | `vectors/payload/A3b.json` | `b4d4b878b7130939a2c73807e3bf06a8b76f76073db5ebf0ad8b6e3de9125330` |
| `vectors/payload/A3c.bin` | `vectors/payload/A3c.bin` | `4dd322f9cdaafc2e4d56098520ba3e260b1f9e2e2bb97131fa2795880328cbb1` |
| `vectors/payload/A3c.json` | `vectors/payload/A3c.json` | `f99bbb91d8fba6d254eda9f6a825981827c9d22870c2c8c1804879d79ddafdde` |
| `vectors/payload/A4a.bin` | `vectors/payload/A4a.bin` | `e3da6cf735a8036c85376d45be1bcba7e3061cb04689d76937be15e3906a585f` |
| `vectors/payload/A4a.json` | `vectors/payload/A4a.json` | `dcecd7b471cf3d40896bdb6a2d8261e8787fed2c14612a5128047b7ba89ba6c5` |
| `vectors/payload/A4b.bin` | `vectors/payload/A4b.bin` | `984599d14eca9807c090557d4f3936e10927d1760ba74f3c9d93aa8395e9c870` |
| `vectors/payload/A4b.json` | `vectors/payload/A4b.json` | `16b60933b40baf00d53d468fb2abb95e3091afd50ff097a0d6638db51dad9ae4` |
| `vectors/payload/A5a.bin` | `vectors/payload/A5a.bin` | `311b96c7009749e50252ff5782f52f2140395e591f17dce6fa909302dfa5b11a` |
| `vectors/payload/A5a.json` | `vectors/payload/A5a.json` | `87d2cb1d3b6772a40b6d14d21c4faed2fcfe8715ddfbc2b74fe9318be8b33a0b` |
| `vectors/payload/A5b.bin` | `vectors/payload/A5b.bin` | `d34424f8bf0b316b778f89c1254064d0b7c50f18608009da3434d1dc2fbac4e6` |
| `vectors/payload/A5b.json` | `vectors/payload/A5b.json` | `c1b7e20230ef212b5aeb73e61d08a432a82455b00566c259cfc25e10b410daee` |
| `vectors/payload/A5c.bin` | `vectors/payload/A5c.bin` | `0b101fc180469fc8f6369b144dc7a54e7677eee8062474abe38b1e17bc4ff543` |
| `vectors/payload/A5c.json` | `vectors/payload/A5c.json` | `5f3f0b0022fef7063f78cd8c2c46999d8cf8d870023b070ffb0fb0359479e9ba` |
| `vectors/payload/I1a.bin` | `vectors/payload/I1a.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I1a.json` | `vectors/payload/I1a.json` | `6554fb844495784a7eedae5f05b81a2b99d7b1a3729725eb7dc5f87af0668548` |
| `vectors/payload/I1b.bin` | `vectors/payload/I1b.bin` | `4b8f8648a9e280d263cf6e9e9437ce74cd28a0ee01c1a90bff5ccc6fa45b3e4a` |
| `vectors/payload/I1b.json` | `vectors/payload/I1b.json` | `1bb8c5d7cf9e97e57f8628107391cde39754f2740a5bdfcd481c86a7db3bf8dc` |
| `vectors/payload/I2a.bin` | `vectors/payload/I2a.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I2a.json` | `vectors/payload/I2a.json` | `71cd5a182c01badc578206f2f179c1d85bb97a0df60b5b7479169512d56197b1` |
| `vectors/payload/I2b.bin` | `vectors/payload/I2b.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I2b.json` | `vectors/payload/I2b.json` | `36eeb27c09713501d81172b94f532556b643ea0485e6a369cc3cff303e3ceef0` |
| `vectors/payload/I3.bin` | `vectors/payload/I3.bin` | `41c2d0b3ba9faeb07c4d4cab503056f2fda2da01c830516f0ca7c64def58b5d3` |
| `vectors/payload/I3.json` | `vectors/payload/I3.json` | `3f945d63950d6f5c68473a39c7b7ca434041508c12a8c0dca7d5e49ff57952ee` |
| `vectors/payload/R1.bin` | `vectors/payload/R1.bin` | `4b8f8648a9e280d263cf6e9e9437ce74cd28a0ee01c1a90bff5ccc6fa45b3e4a` |
| `vectors/payload/R1.json` | `vectors/payload/R1.json` | `ed875032bba343ead9148129c43072a75bf9ae1f6099dc43fa7c8c42c7de933c` |
| `vectors/payload/R2a.bin` | `vectors/payload/R2a.bin` | `ff700797fdedbbdea6f6d74b16c1943bb87118db08310d29aac373e3c6101c1b` |
| `vectors/payload/R2a.json` | `vectors/payload/R2a.json` | `895620669e1e8fd7f2fb22c6bab08984e50c2cafa496dd662390b8563e4956f5` |
| `vectors/payload/R2b.bin` | `vectors/payload/R2b.bin` | `a641d3527983c2d4b51aae7d270d130ae3f22fbad67f0e42928c303a930047f8` |
| `vectors/payload/R2b.json` | `vectors/payload/R2b.json` | `35ec418a1a64b0c78241a568cde91ebb11ced3ed668f513bbd6171a652bc73b1` |
| `vectors/payload/R2c.bin` | `vectors/payload/R2c.bin` | `5402feff6d5135c7e9b9288847d58a1e8410937dcdc276e257e36331baa274a6` |
| `vectors/payload/R2c.json` | `vectors/payload/R2c.json` | `c3c6829acee035e8ce0fc0b2a7d001563f85d051ef19556fd128b519281195e7` |
| `vectors/payload/R2d.bin` | `vectors/payload/R2d.bin` | `7ffa5e5804f92b32d3fdc1c50f2f8c4fdecbbbc52edb55ad17d751bf348f7bdf` |
| `vectors/payload/R2d.json` | `vectors/payload/R2d.json` | `6e45d51a87f26f90e831668557abf908f0a8278e35f08b04a8a6efdc786a1246` |
| `vectors/payload/R2e.bin` | `vectors/payload/R2e.bin` | `391b4394aa40594a92a03e20266a14d93b1c374f894bf8983fa18db1b769dac2` |
| `vectors/payload/R2e.json` | `vectors/payload/R2e.json` | `dbe9cff14eb3553991497eb1cc6f74dbc8db7096af534fb50b5af9176f1daa52` |
| `vectors/payload/R2f.bin` | `vectors/payload/R2f.bin` | `88f3c531a4537b619ee6e09257e671457abe9fc531ae2742e427977ed348bc4e` |
| `vectors/payload/R2f.json` | `vectors/payload/R2f.json` | `8f2aeec2245e825b79603e563b0e182fb44208e58e9b6e17a7528bc957947921` |
| `vectors/payload/R3a.bin` | `vectors/payload/R3a.bin` | `98a638e2e5a9163529f1f091d4e926bf5a0600398414be19f87cd3a26702bdd1` |
| `vectors/payload/R3a.json` | `vectors/payload/R3a.json` | `198e36e681935622ad313b7b526ce57ac7129f67a0ca5644eaa5d3a74bba4de8` |
| `vectors/payload/R3b.bin` | `vectors/payload/R3b.bin` | `a52a9ffe8a92b7a12f83c0e854cbc3e6fb6f1fabb892fd559d9c634cfb2156a4` |
| `vectors/payload/R3b.json` | `vectors/payload/R3b.json` | `99afeb4d28fea6236b33f7c605309ea3dfe94037069c1bd0b0a7d75744765c20` |
| `vectors/payload/R4a.bin` | `vectors/payload/R4a.bin` | `7015db5e50158e15b05bb22fa29d03f79d48d078511c5a0c7b1d7152de3b11cd` |
| `vectors/payload/R4a.json` | `vectors/payload/R4a.json` | `3f7994ce950cf3e1adf5f9ce1332c0c1780c840836b344516c2d2047d61a746b` |
| `vectors/payload/R4b.bin` | `vectors/payload/R4b.bin` | `4d83dc4e2ee2e4592f9ca1973a2e121ae9ab140342448c48d9f867278108d0ef` |
| `vectors/payload/R4b.json` | `vectors/payload/R4b.json` | `6db8e89f959992a529c4ef8f3b9d86df940b66503662ccbb34425d80581e40d5` |
| `vectors/payload/R4c.bin` | `vectors/payload/R4c.bin` | `3d51d4fdbc43f7fce60e864b6a08e9c13c0667d15963c2645db6a8e941aef071` |
| `vectors/payload/R4c.json` | `vectors/payload/R4c.json` | `5ecc570ff1b7f1427fa55078215adb9503b5bfdc6ec27e04431ddf4c6b434217` |
| `vectors/payload/R4d.bin` | `vectors/payload/R4d.bin` | `26c6442afc323d224fada178d38905a0fac07b709a4f2dbcd7fe947b9c72cbba` |
| `vectors/payload/R4d.json` | `vectors/payload/R4d.json` | `904a13f52ad4454095dc4de0567e064c819285b51a9df809a021d459993146f7` |
| `vectors/payload/R4e.bin` | `vectors/payload/R4e.bin` | `11a26a4de57bf3228b95d91d06e272c1fc7b070807525dc8d60f58f1f5f810d6` |
| `vectors/payload/R4e.json` | `vectors/payload/R4e.json` | `7fcebeb163b9ee31e967bfad751e0cfa77f7537232df8b8411bb7ddeb02b76bd` |
| `vectors/payload/R5a.bin` | `vectors/payload/R5a.bin` | `675e39320b7760ab6884730015e1d48352ede42c61c8ec5e51df39184dc7ba14` |
| `vectors/payload/R5a.json` | `vectors/payload/R5a.json` | `8072ae720b8507683ce46f5a68eb4f89178b89b06ba5391283847f2c6a79699c` |
| `vectors/payload/R5b.bin` | `vectors/payload/R5b.bin` | `0b22485ac7b8d19cdbba8d034121f31d3229ecdfa8c036f08389bf5e66fe1f06` |
| `vectors/payload/R5b.json` | `vectors/payload/R5b.json` | `35751d0689f721a77992065429f243ece4a782f7f3107f14b2adc5e05b202528` |
| `vectors/payload/R5c.bin` | `vectors/payload/R5c.bin` | `6e7010ea77a40ad199411dae4706766e249a5be1f63cf53ddd74367595275ca2` |
| `vectors/payload/R5c.json` | `vectors/payload/R5c.json` | `082a750f48c3437321a115c0dce68052741a36c5a503913007a0701deddbae71` |
| `vectors/payload/R5d.bin` | `vectors/payload/R5d.bin` | `0ab49042633e1c2f08f3d7688a2921ed577b4833cff9575a12f7bafa8e2a6c2f` |
| `vectors/payload/R5d.json` | `vectors/payload/R5d.json` | `6a8bdb2c5d18f27b58669d2eb77af0f3415ab7a0059a66f00e6dde47e35c2238` |
| `vectors/payload/R5e.bin` | `vectors/payload/R5e.bin` | `638da465654c6a2ecd78926557e3f43568d5c5fa3c11ea19e886be71cc564614` |
| `vectors/payload/R5e.json` | `vectors/payload/R5e.json` | `538883e40531ad80fcf324a76db02e2f0d16889d0b520a3d1e2d229b36b4b324` |
| `vectors/payload/R5f.bin` | `vectors/payload/R5f.bin` | `a40c9274e395769b55e6c336f74f50704094939f4de0b64a10ae20d59a88ec9e` |
| `vectors/payload/R5f.json` | `vectors/payload/R5f.json` | `dc8f9d5b4f03f0500ee967975dba86a059f133552bf68ad9f453313bdac95558` |
| `vectors/payload/R5g.bin` | `vectors/payload/R5g.bin` | `5ddba4ee302680f1d6ac00887a90c186eb56cebe21f671fd4359e0636d20fa0b` |
| `vectors/payload/R5g.json` | `vectors/payload/R5g.json` | `2b8c1caf4918b1de10d9c255e99df1e53f6628d11ce1f537403fcbbfb8acc2ce` |
| `vectors/payload/R5h.bin` | `vectors/payload/R5h.bin` | `083a66bc9f6e42610149b944f16c3c160311ddf5433d4f5551c1fe1e1edb0e83` |
| `vectors/payload/R5h.json` | `vectors/payload/R5h.json` | `0b34bc67a9ad7b74b3a782a3b954abcc1b58abbb2d52f4c7f965f59a035b089a` |
| `vectors/payload/R6a.bin` | `vectors/payload/R6a.bin` | `da05b2a579d25becefff6bfecf787dcda49de6f24693f9f6f0839f8c57c437eb` |
| `vectors/payload/R6a.json` | `vectors/payload/R6a.json` | `768e526ab8f9bd41d0f2beac2a5d34acef4cea33110235a967f6041ca2522223` |
| `vectors/payload/R6b.bin` | `vectors/payload/R6b.bin` | `99bfcb77feda44689a180a3580e03251b2af0177085a015f5ffc10c54b229c10` |
| `vectors/payload/R6b.json` | `vectors/payload/R6b.json` | `68648cb948bce2c3eb16c0accf71f8b606454746ba141cac2352b134ebc302f2` |
| `vectors/schema/manifest.schema.json` | `vectors/schema/manifest.schema.json` | `e545d9315ce844c78cb32294737d3be768686947a52e74ed3f333c6fe6870fbd` |
| `vectors/schema/payload.schema.json` | `vectors/schema/payload.schema.json` | `fd78d549aa9d0d30f52e356262afe0ff661200ae5ea19016cce9bba52474a7a7` |
| `vectors/schema/runner.schema.json` | `vectors/schema/runner.schema.json` | `973c0612f6641c4c90740ac056e7ea3b7a1ae80309db14602e7c3349098cfe4d` |
| `vectors/schema/state.schema.json` | `vectors/schema/state.schema.json` | `f29bfc39d74ecb227c7325b929deacc743719a1d2ba872ee7ea5fb6098208816` |
| `vectors/state/A3a-state.json` | `vectors/state/A3a-state.json` | `4b47b5a2767598f63037a0388a2286c6f50248ad09570539d95dccf823b48dd3` |
| `vectors/state/A4b-state.json` | `vectors/state/A4b-state.json` | `104b7e9eeb993442ae5dcef33f3acff826bb7db376de191c3d412411fcfe9d65` |
| `vectors/state/A5a-state.json` | `vectors/state/A5a-state.json` | `3526bc84dfa8b277b8da7e9e9aeb211a312ed0860e08de0b7c6287b63bf3ac5c` |
| `vectors/state/A5b-state.json` | `vectors/state/A5b-state.json` | `287a5ec7ca13828a484f9673e5f0b117457086a4caa21483e72a61315c85160b` |
| `vectors/state/A5c-state.json` | `vectors/state/A5c-state.json` | `1bd0d7b277415c3c4c26c4c8f0e335974acd173ef08c435cf82aafc9c17784fc` |
| `vectors/state/S1a.json` | `vectors/state/S1a.json` | `d58e34d26c9c55ef346d3424efb760414ce6400cd4e752caebbdb384b4109bc7` |
| `vectors/state/S1b.json` | `vectors/state/S1b.json` | `92d01937548d04eda16b79f517909f09124b938f80b6656044c54639e6c34e08` |
| `vectors/state/S2a.json` | `vectors/state/S2a.json` | `660613210937f03f3850622ab94fc53939160518fe9758c275d9021acc1db286` |
| `vectors/state/S2b.json` | `vectors/state/S2b.json` | `0f491fdd96d47e5af27c607b1dfa03fe3a17a650bf5f53e0a2466d8f10d8e44f` |
| `vectors/state/S3a.json` | `vectors/state/S3a.json` | `c4dbf7f69ade3069c28ad0992b5ff78a9368b71fd2296291cfb097a021e5cf42` |
| `vectors/state/S3b.json` | `vectors/state/S3b.json` | `3894bf8d4e34335cf8b45c4719b3aa425a2966117609d56ab0cc385723b30455` |
| `vectors/state/S3c.json` | `vectors/state/S3c.json` | `253b335b2b6b44e307398a73d85139ee976401a1d1836d486a5266f5139d9b49` |
| `vectors/state/S3d.json` | `vectors/state/S3d.json` | `3853c9cee033f8708838332cafdcf48aaef1065d1afbdaaec4fe3a156bd4d91e` |
| `vectors/state/S4a.json` | `vectors/state/S4a.json` | `5e1c04732d2f68b65f81449fe30cfa605a13a061578934e9394d3c82bb24713c` |
| `vectors/state/S4b.json` | `vectors/state/S4b.json` | `21c1f8381cf25210510fcf58deb68f6b1b5a7fda0d8710a5a0db5e083f8f3696` |
| `vectors/state/S5a.json` | `vectors/state/S5a.json` | `c4ec4ab5351a3d5c9b326bf719e720d93fe9258666dbc81a5491a13ae46c1ade` |
| `vectors/state/S5b.json` | `vectors/state/S5b.json` | `6d2bb5fc3de704ccdea80ef30e6fe2729ddaae4367da25607cfce9eec5913ed0` |
| `vectors/state/S5c.json` | `vectors/state/S5c.json` | `5556dac362c21127e96404d396787b314cdd7765b40fded92587f9adf2899235` |
| `vectors/state/S6a.json` | `vectors/state/S6a.json` | `758cab1b501dfe707b1950dc1151dc1c4b81516dc766bbffd183ed231e9a353f` |
| `vectors/state/S6b.json` | `vectors/state/S6b.json` | `47971c9b0b1285cbb02b31ec797c6a65c8d68e9980ab9763a8f8cfec8ca3b4bf` |
| `vectors/state/S7a.json` | `vectors/state/S7a.json` | `a726dc9e56517126cff1c46acc92f4e639fcacaa501071e7f3fcae6f8a96a4e7` |
| `vectors/state/S7b.json` | `vectors/state/S7b.json` | `624fc231b8e786c08b4c1cee69dfdf7545113694b39a26c3151f7e7a201a7b9d` |
| `vectors/state/S8.json` | `vectors/state/S8.json` | `c58ba491d642699382dd0b3d3027ba159dd47f947bf64559540b173210f39dd1` |
| `vectors/state/S9a.json` | `vectors/state/S9a.json` | `dfa1782e83c349335e6dee32f37d38508fea2ed3e2eb828a8ecefde54b916cd8` |
| `vectors/state/S9b.json` | `vectors/state/S9b.json` | `c1b760101b568e88e291e0599fb833cd9f764a865943140512abb0697a619afd` |
| `vectors/state/S9c.json` | `vectors/state/S9c.json` | `7e8475716727815b29653cae7a93cfdfaa7d98df96aa5b6cb71eac14f84593cc` |
| `vectors/state/S9d.json` | `vectors/state/S9d.json` | `83a63d62a5be96aa1127581001b18f5a714d6b89dd0da685509f8c191d2ee4a9` |
| `vectors/tools/common.ts` | `vectors/tools/common.ts` | `1c5bd70270cf2ff118cbccf213fdaaab8f9b5de101f48c36d220f143dbc5510f` |
| `vectors/tools/compare.ts` | `vectors/tools/compare.ts` | `8d900cf01d1288370ea60126347bccb7240186c8d41029de34b30d7a810fb447` |
| `vectors/tools/run.ts` | `vectors/tools/run.ts` | `7599711a9c28f5a34b5157cb7d4583afd793e0304e3911261b48df845b237e6c` |
| `vectors/tools/runner-core.ts` | `vectors/tools/runner-core.ts` | `83cea1d295e4623622746ef20b611b6124a552434326a12585a1dd75b17cb782` |
| `vectors/tsconfig.json` | `vectors/tsconfig.json` | `cb6faae9b1e50f96a5022c3c3deea257b630f53cb49e8cd2417746c36bc7a810` |

## Verify

```sh
git -C <clone of midnight-experiments/mip-0018> rev-parse HEAD     # daec1f19747b09f4e245885ab0dd9ecc789a82ce
git -C <clone> show daec1f19747b09f4e245885ab0dd9ecc789a82ce:<upstream path> | sha256sum   # equals the table
npx vitest run token-indexer/test/mip0018-provenance.test.ts        # recomputes every hash in this table
```

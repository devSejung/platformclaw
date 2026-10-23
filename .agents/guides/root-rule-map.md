# Root policy migration record

Audit data for the root-policy split. This is not an additional instruction source. The source digest identifies the pre-split working tree, including the earlier approved delegation and validation-policy changes. Each rule maps to an owner and a whitespace-normalized SHA-256; explicitly recorded latest-main supersessions retain the historical hash and add the replacement with revision and reason; headings are structural and are not counted as rules.

The pinned upstream additions and intentionally excluded changes are recorded below. Future policy edits belong in their owning guides; this record documents this migration rather than imposing frozen text on future work.

```json
{
  "kind": "root-policy-split-preservation-audit",
  "source": {
    "path": "AGENTS.md",
    "sha256": "7fa64bd783411a058680c1e26549bc7da22c5f8e0253491715e6b2848560effa",
    "characters": 69208
  },
  "normalization": "Collapse whitespace only; pre-split instruction units are retained verbatim apart from formatting, except latest-main supersessions recorded on their mapping entries.",
  "rootLimit": {
    "charactersLessThan": 20000,
    "utf8BytesLessThan": 20000
  },
  "upstream": {
    "repository": "openclaw/openclaw",
    "commit": "d3eec4c06862499f53f1f259c0daa08096d4ed6e",
    "adopted": [
      "Full task-owner guide reads, including cross-directory callers",
      "Proof at the real failure boundary and reuse of valid proof",
      "Shared-checkout safety",
      "Capability surface ladder",
      "Answer-changing cache identities and current owner authority",
      "Independent caller-visible regression fixtures and baseline-failure honesty"
    ],
    "excluded": [
      "Relaxed landing of unresolved tests",
      "Pending/stale ClawSweeper landing bypass",
      "Unavailable backend defaults",
      "Unverified upstream-only runtime helpers/test paths",
      "Harness package/runtime upgrades"
    ]
  },
  "mappings": [
    {
      "id": "R001",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [3, 3],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "43555707c37395f978bd90c413139bda2af095b615bdcf5738b8bc9bcab3103d"
    },
    {
      "id": "R002",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [4, 4],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "815bc1d531d019903f819de6bceb05521eafb654ae0c10dee5e3a8d70574f7d4"
    },
    {
      "id": "R003",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [5, 5],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "d1d50c5c80820d4390ba68725f51c0fc890be14c0d5b3565128ffb098e2ca2bc"
    },
    {
      "id": "R004",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [6, 6],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "805d1cf888a732fa8a389f66112077a56f380cf04357b3d5bd15686b78056d1d"
    },
    {
      "id": "R005",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [7, 7],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "589b634af93a7886849e3da4d88dcb5a59ced74fe9b1cff17dfb90ecf0fe27bc"
    },
    {
      "id": "R006",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [8, 8],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "5faf2b559b2d1a11418d26415e12f8985123d05953a617ec5469e95d775f78b6"
    },
    {
      "id": "R007",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [9, 9],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "5bef7698d2e4b4bbb74638389f784cf7e59a1c8ee4cdc8a22830a482d3260c7b"
    },
    {
      "id": "R008",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [10, 10],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "707eb183f1354bffbf394679391a909ae73c5c94e8ee1830d06383c76453aedc"
    },
    {
      "id": "R009",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [11, 11],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "c0ea21fbffdfcd7a8c794076567d0f6d92ed9d2fbd56dd75304ae4078b9134e4"
    },
    {
      "id": "R010",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [12, 12],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "fb946b6ca39bc6bced77309176b6e1c0c78e30eec3860ceb3bf4f94a07b162ab"
    },
    {
      "id": "R011",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [13, 16],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "1bb56a14993a76e3d996514e0d246904db6b0d8922cb0f256fa0ec7bd9e770bb"
    },
    {
      "id": "R012",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [17, 18],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "a5901a9cf11be58156de9b8f5a0da5685c6a45187eb3cc7c013805a3c1ca5aed"
    },
    {
      "id": "R013",
      "sourceSection": "PlatformClaw Overlay",
      "sourceLines": [19, 19],
      "destination": "AGENTS.md",
      "destinationSection": "Project boundary",
      "normalizedSha256": "43cfa917ff5fa5912efd00a32df6c3ecaf540a5579a1872e9370dae8178172c6"
    },
    {
      "id": "R014",
      "sourceSection": "AGENTS.MD",
      "sourceLines": [23, 24],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Scope",
      "normalizedSha256": "a4dc8e2435bbee2e321e149531722e3e217bd042fc3e938b3e942b2ed377a9ea"
    },
    {
      "id": "R015",
      "sourceSection": "Start",
      "sourceLines": [28, 28],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "a1112472e4bfca494264075bb5b32a53100a97346a2be840669896f926ed94f7"
    },
    {
      "id": "R016",
      "sourceSection": "Start",
      "sourceLines": [29, 29],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "b0a363076e037d9d49edee0e78ad5f8b32fa5c23464636e53a08974fabc07bd3"
    },
    {
      "id": "R017",
      "sourceSection": "Start",
      "sourceLines": [30, 30],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "dd1b9bb539b6d1f09a362304fe8d92273af948c44dc335e165723a5e9afbaf38"
    },
    {
      "id": "R018",
      "sourceSection": "Start",
      "sourceLines": [31, 31],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "bd3aabb8c2f64955aee2bf9037f405a9d16e11d0dea5137309ada3911039ebaa"
    },
    {
      "id": "R019",
      "sourceSection": "Start",
      "sourceLines": [32, 32],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "ba76a02f80ab96777da6e11f28cacc2fa40be28c8bf8fcea0fb0bfc3262d03d3"
    },
    {
      "id": "R020",
      "sourceSection": "Start",
      "sourceLines": [33, 33],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "90d28c2528618a633e531b297d97d1121a834bc47b18e507eb8e68e1f53a54c3"
    },
    {
      "id": "R021",
      "sourceSection": "Start",
      "sourceLines": [34, 34],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "75e10aaf82f3d149fa04b51b257e577c3cc680095fb2ca94c4c4a8d76ec99c24"
    },
    {
      "id": "R022",
      "sourceSection": "Start",
      "sourceLines": [35, 35],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "b20a3e21324d4a4b7c465cb751140b0ce90f538859d7656d4555b0174220afb1"
    },
    {
      "id": "R023",
      "sourceSection": "Start",
      "sourceLines": [36, 36],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "106f5d88575edcf7a2940aa7005409c90566a4574e981b61a9d76d3a8aa7163e"
    },
    {
      "id": "R024",
      "sourceSection": "Start",
      "sourceLines": [37, 37],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "6c8529d00e941bc4a16037d7257d64dac6d7d06abfcde83a5fcc49853a1b571b"
    },
    {
      "id": "R025",
      "sourceSection": "Start",
      "sourceLines": [38, 38],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "4a1699b694b6aa880b564a4f1267a1c747cc7f09a173131f3cfdf81110bbc7a0"
    },
    {
      "id": "R026",
      "sourceSection": "Start",
      "sourceLines": [39, 39],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "a6e444272b479752133960c592e15a5f79ab383223774e49a674cba08590d03c"
    },
    {
      "id": "R027",
      "sourceSection": "Start",
      "sourceLines": [40, 40],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "7833ad66e4690fc65c9aef744b00cf0658293f3f6a4add03654f0621a82eea81"
    },
    {
      "id": "R028",
      "sourceSection": "Start",
      "sourceLines": [41, 41],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "34c95a09b25fc8024c7499815d9b53ba0f0676ba0cee2f5530e77768cceb184b"
    },
    {
      "id": "R029",
      "sourceSection": "Start",
      "sourceLines": [42, 42],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Start",
      "normalizedSha256": "e0e4a36d60701dd2d77c6edd9544fec1bcbe34f099e97fa398ddfe301e23277c"
    },
    {
      "id": "R030",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [46, 46],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "01cbe02eab664b19a981cb81da508fd63625c55f06672328d6cc539c37f15080"
    },
    {
      "id": "R031",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [47, 47],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "4132f24406948c8ebf2f5c99be500eac990c8c13473e7787953f8a477396cb66"
    },
    {
      "id": "R032",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [48, 48],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "229907a0c4ba2267b1cefa706df95bf127d2bb9d391add809cdd6d4f41635e4d"
    },
    {
      "id": "R033",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [49, 49],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "1a2183058e381ca0e5d8ce1f44e116d3390e8d5157043af45b73679a888b6f7c"
    },
    {
      "id": "R034",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [50, 50],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "c5d814eba5a2dc40e8cad3fe6ae84c80419f5eb51327231b15be7c2f93b6b4e0"
    },
    {
      "id": "R035",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [51, 51],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "9735b6d4500f0b160f0f1c0acd35e87df274318dff9461c4c0daeb0d4c20e81a"
    },
    {
      "id": "R036",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [52, 52],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "6c9e4afca55dbaf8f559c54f2ef3d6edc7868734e9079cb63b6eef2f69f32372"
    },
    {
      "id": "R037",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [53, 53],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "22733cdf9cfcf49712ef66f14c7b35f246d9651e7082577aafb1ea9477df419a"
    },
    {
      "id": "R038",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [54, 54],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "06d8a206aafd7dda2762fdf9bc68bbfbe199d69499a9adb817275c3d66214edd"
    },
    {
      "id": "R039",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [55, 55],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "855f55cb9198f8c10b6d35ec08b96d6b9096440af631736b25094cbab3af9277"
    },
    {
      "id": "R040",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [56, 56],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "f562116b9c4aaea90631f0eacf9d408b021bc44718ecaf2febcc7e810b3a2d41"
    },
    {
      "id": "R041",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [57, 57],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "d758e778175ff3f6ea556d342aa18a90b806b57a6e68a99f562e08b8c5453d0b"
    },
    {
      "id": "R042",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [58, 58],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "60a1c53da7301af6c8832b0a388aebe47078644b2cb981727423c1d95b1c3c80"
    },
    {
      "id": "R043",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [59, 59],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "f8f597577d7d0b5bd60ca0cdf84212aa3d1768d00e9c677e096faf623da6ee39"
    },
    {
      "id": "R044",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [60, 60],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "17aa24cf1e3d30d91d93901500622e7d777c8d1986568ed39f173da452658f6a"
    },
    {
      "id": "R045",
      "sourceSection": "Repair Doctrine",
      "sourceLines": [61, 61],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Repair Doctrine",
      "normalizedSha256": "879aa107d1e1f0626a4040e15a8da7d276e6d7d1dc87f23df4c9c5f703e86b5a"
    },
    {
      "id": "R046",
      "sourceSection": "Product Doctrine",
      "sourceLines": [65, 65],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "e9e0496f1a4d0e9674b09786495238a4f7cf855987f964108a765892bfec0de0"
    },
    {
      "id": "R047",
      "sourceSection": "Product Doctrine",
      "sourceLines": [67, 67],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "713741094afe405d76943c35a00906474ce52b120951db51da5ab2ff265a90b9"
    },
    {
      "id": "R048",
      "sourceSection": "Product Doctrine",
      "sourceLines": [68, 68],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "eaf9b544c5e2cec0333fda3ba10b3f112d09f51d938df0ba505bd397057aeb82"
    },
    {
      "id": "R049",
      "sourceSection": "Product Doctrine",
      "sourceLines": [69, 69],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "4bf4315be08f85b2721bcd22af664a0f61310e19c8f8d61a12be582f977cc582"
    },
    {
      "id": "R050",
      "sourceSection": "Product Doctrine",
      "sourceLines": [70, 70],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "51e1e83cadea0dd68fa3725441bf9e06af58c6147ac5d170d521eb51741fe723"
    },
    {
      "id": "R051",
      "sourceSection": "Product Doctrine",
      "sourceLines": [71, 71],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "132aa14478e336108958cb1547ef28d8764027c5e13ce094935c688b3c862e1e"
    },
    {
      "id": "R052",
      "sourceSection": "Product Doctrine",
      "sourceLines": [72, 72],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "4cf6dc151267326de63e84057e64c482c672c30c56592a4f44e7608762216924"
    },
    {
      "id": "R053",
      "sourceSection": "Product Doctrine",
      "sourceLines": [73, 73],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "d6f3dcdee7a6a67369fe63ff60a26100ae0b7cf406925f43d4420cb42818b94d"
    },
    {
      "id": "R054",
      "sourceSection": "Product Doctrine",
      "sourceLines": [74, 74],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "7908adc677e6bde1865e89dd818eb9cee4fe3e73a80793521166b5ecdd65115e"
    },
    {
      "id": "R055",
      "sourceSection": "Product Doctrine",
      "sourceLines": [75, 75],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Product Doctrine",
      "normalizedSha256": "f8d8ac1a49d9f562c468cbf64c842aec4ac7bffacc673d6d9df1cf658599c78a"
    },
    {
      "id": "R056",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [79, 79],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "0a1168348f3ef1f95cb4541e909740d844aece82546a7b365d3de4b01d860b7e"
    },
    {
      "id": "R057",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [80, 80],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "ce414bf5bdb4a02d44fc29e60082f83a557f4256ae1ba4b4f9c274b2dc5a396e"
    },
    {
      "id": "R058",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [81, 81],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "feeb52d2b3ab0e9de1f1f881067be95eb7034b846460924c09e859bd5db1c446"
    },
    {
      "id": "R059",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [82, 82],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "7b2993c7ab7b15d1551c6a7acc67b999788b089f14a35c3c3c3caf9f8f45e485"
    },
    {
      "id": "R060",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [83, 83],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "89f34962a5ca81242aaa9a16bf5f10efb8ffde5613744f1e8d0d31bff1289bf0"
    },
    {
      "id": "R061",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [84, 84],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "b8d716389f25925af3338a94222d004b4c2f43985f9e9ff654753bc56928721f"
    },
    {
      "id": "R062",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [85, 85],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "348c7a5516c05d2ca265bce54be8a7a67b64e44fd4c0550b9571e0cca2a7a0ac"
    },
    {
      "id": "R063",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [86, 86],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "23976a6ec13fb99c38195b03b70ac823269cfc50004c022bf4bab04a0c7ea8d0"
    },
    {
      "id": "R064",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [87, 87],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "f6ec52b11856b74a989dd1b685dde8becd4c56799d85fcfb50363af7099bf9d4"
    },
    {
      "id": "R065",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [88, 88],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "8644d6875a15fae1d7fde4d8a1c86453ad0b20056a871d5508c5427a2ac02470"
    },
    {
      "id": "R066",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [89, 89],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "802152f1c2bc3567ab5d228e46cbac8a4eea505d5c30d9146f6de984fd0f2c99"
    },
    {
      "id": "R067",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [90, 90],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "c9d0304bd93b2e48d9a51bb226208ada53a18670136e3927b3226497a955f4e8"
    },
    {
      "id": "R068",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [91, 91],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "4031a67a46e2863da625c3eb4d198391ce173d5bed87b29d70738192752aa766"
    },
    {
      "id": "R069",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [92, 92],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "a94ce50a459ca69f748f7d6d26489f8a5b4ddf205c5e32848be20a3d35fd0580"
    },
    {
      "id": "R070",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [93, 93],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "07c4384a528e86b0158dc393a36f60e7510a3436c06abd4347f8ed81d0ee02b5"
    },
    {
      "id": "R071",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [94, 94],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "76e72b558446aa198505fc4d952ae38486134797f3937b1c2fecdb6dd8580d32"
    },
    {
      "id": "R072",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [95, 95],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "8154ae4c2500728a27e3e3012472ecdac879d6dd1b46ad21bb43cffb6eae5621"
    },
    {
      "id": "R073",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [96, 96],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "b3fccbbceb25cf17979274dc86621e14080c0c9759a77bbe95c6a8ec55bde087"
    },
    {
      "id": "R074",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [97, 97],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "88a1bf972c4e9093121b24a68ba72619280e3dbc90ba11a7abd00c691ceced80"
    },
    {
      "id": "R075",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [98, 98],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "be0d595b7d7758d56dcad4685f7683de3598406f9950f59e9d008bd1f50b0654"
    },
    {
      "id": "R076",
      "sourceSection": "ClawSweeper Review Policy",
      "sourceLines": [99, 99],
      "destination": ".agents/guides/review.md",
      "destinationSection": "ClawSweeper Review Policy",
      "normalizedSha256": "1aff083edca1c9ecb844ef7ddcb57d40d9b9b1ec7442f88576c85031edcc1937"
    },
    {
      "id": "R077",
      "sourceSection": "Map",
      "sourceLines": [103, 103],
      "destination": "AGENTS.md",
      "destinationSection": "Repository map",
      "normalizedSha256": "c7463b55ff2b353afb3a1416a087ba085258ee7802fa898f9f88b79a80b073f8"
    },
    {
      "id": "R078",
      "sourceSection": "Map",
      "sourceLines": [104, 104],
      "destination": "AGENTS.md",
      "destinationSection": "Repository map",
      "normalizedSha256": "cf849d39b7a562440fe74c7e289b44c028a267a3567310042eff0205dde404bf"
    },
    {
      "id": "R079",
      "sourceSection": "Map",
      "sourceLines": [105, 105],
      "destination": "AGENTS.md",
      "destinationSection": "Repository map",
      "normalizedSha256": "59d9f6b49246cea6bee5acc7a7a7f789496430133aff5ebe6129af21f7185d72"
    },
    {
      "id": "R080",
      "sourceSection": "Docs",
      "sourceLines": [109, 109],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs",
      "normalizedSha256": "e04824715f517192363a3a28039c300c87ebbaccdee676bbd766d2191f9a4cf5"
    },
    {
      "id": "R081",
      "sourceSection": "Docs",
      "sourceLines": [110, 110],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs",
      "normalizedSha256": "2b1840e1df265e3468737c8335dcf0ba0398c5bf7610c1c0ea4b01c452f8b98d"
    },
    {
      "id": "R082",
      "sourceSection": "Docs",
      "sourceLines": [111, 111],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs",
      "normalizedSha256": "1c5897de6c6472712055cba990256cf48f370a98d9f1a05403b2b972890d0db7"
    },
    {
      "id": "R083",
      "sourceSection": "Architecture",
      "sourceLines": [115, 115],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "4f32b5eb7f5fe7c6db90de3110fb5cffc56396eef4f11ccb8189274453ad0201"
    },
    {
      "id": "R084",
      "sourceSection": "Architecture",
      "sourceLines": [116, 116],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "3f14f1f6146c540fef8b616f429c9787e55809580c6bd3cf6ec5c54bdf3be1e2"
    },
    {
      "id": "R085",
      "sourceSection": "Architecture",
      "sourceLines": [117, 117],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "f1f3c2ab8d06389ee450ba4b152d3c7bb828bc99779bb889b7b1f4cc3c310daa"
    },
    {
      "id": "R086",
      "sourceSection": "Architecture",
      "sourceLines": [118, 118],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "4076aeb8eed175432323b31accb65bd56479f25a6c94726395c686ab02ae84e4"
    },
    {
      "id": "R087",
      "sourceSection": "Architecture",
      "sourceLines": [119, 119],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "ad19d15f435c580ee2382ed72cacba1cf4b3c1197e8b3680fd9b9081bb57ab6d"
    },
    {
      "id": "R088",
      "sourceSection": "Architecture",
      "sourceLines": [120, 120],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "a7bee8b13c9af937cd3f94c34cfd9d3e433d6a640c0fff1fe3c28db0f6b38bc4"
    },
    {
      "id": "R089",
      "sourceSection": "Architecture",
      "sourceLines": [121, 121],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "bc8238adc3a71682f0f3f1f3c32c7ab978fc2d95461fa8f089c177fc01ee44b5"
    },
    {
      "id": "R090",
      "sourceSection": "Architecture",
      "sourceLines": [122, 122],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "18e92d3a572a4fcdb39b392c5ed34b6bfba2fab1bdc94a87f786c34cbb403e38"
    },
    {
      "id": "R091",
      "sourceSection": "Architecture",
      "sourceLines": [123, 123],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "da20261b19b1cebcda446e51b45e3b5048b195d5557f3b9b754b14dc7fb57df6"
    },
    {
      "id": "R092",
      "sourceSection": "Architecture",
      "sourceLines": [124, 124],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "6f4df2c5791e4b44b72c8da7e87a5c5e7285bfacc70409a2ca229e49a9e9e115"
    },
    {
      "id": "R093",
      "sourceSection": "Architecture",
      "sourceLines": [125, 125],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "f4caafccbf215b3dc0e8c4411d6014783733d92f9e53447d9e1a2aa89d3264f9"
    },
    {
      "id": "R094",
      "sourceSection": "Architecture",
      "sourceLines": [126, 126],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "ca352524ecada511314fad168e9ad1c526a90f530bc59a0e59ec1ff3e43b896c"
    },
    {
      "id": "R095",
      "sourceSection": "Architecture",
      "sourceLines": [127, 127],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "e673de40555d3f4f4f752a96a6c86e96ea21e114ce40c6081b017c535c217159"
    },
    {
      "id": "R096",
      "sourceSection": "Architecture",
      "sourceLines": [128, 128],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "7442120078c2bdaee68bf85ce9ffcaf75912aa60217e6a8a0a2ddae39b4e0e1f"
    },
    {
      "id": "R097",
      "sourceSection": "Architecture",
      "sourceLines": [129, 129],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "258d6fad4e5e4e46deb24cdac102686a362f718ed0062b0daa42cfda44d3e9c9"
    },
    {
      "id": "R098",
      "sourceSection": "Architecture",
      "sourceLines": [130, 130],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "a4e9132b1d4d4e1ec48f4be3e10f72d302b745740b807ac4cd203012c63a83c1"
    },
    {
      "id": "R099",
      "sourceSection": "Architecture",
      "sourceLines": [131, 131],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "350f005beed1e9dffcf5889bb0582f3a1c58492400af70061762d54e2e1f2b59"
    },
    {
      "id": "R100",
      "sourceSection": "Architecture",
      "sourceLines": [132, 132],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "2c66e17fae787b0a02b5c49e7d11fb3294dde10b5349aea2005b36e8d2379dcc"
    },
    {
      "id": "R101",
      "sourceSection": "Architecture",
      "sourceLines": [133, 133],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "d074491ee680eda829abbbfc76b7c8d213ac07b06858f8f0601fca9ca559cb3a"
    },
    {
      "id": "R102",
      "sourceSection": "Architecture",
      "sourceLines": [134, 134],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "9f4e676ee4082c9d00ed9dea2bc3a8be8eb6662ea6751a002687adc47a776297"
    },
    {
      "id": "R103",
      "sourceSection": "Architecture",
      "sourceLines": [135, 135],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "7abdfcd9cc8a89ac69270e616750f0f2123492783c7fb1edc40e668dcc03e8d3"
    },
    {
      "id": "R104",
      "sourceSection": "Architecture",
      "sourceLines": [136, 136],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "814336d28ec2eb6d83f355119d49fd556d71647957e34cefdb9f5fa72d713d00"
    },
    {
      "id": "R105",
      "sourceSection": "Architecture",
      "sourceLines": [137, 137],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "e0241adc2e44454bc8aa88bda07de36c5739192c249a80f493f95ccebf796d44"
    },
    {
      "id": "R106",
      "sourceSection": "Architecture",
      "sourceLines": [138, 138],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "421c6b150a7fc49748a6883f71bbf9cf15600496d408746a7757f2fbebc783a5"
    },
    {
      "id": "R107",
      "sourceSection": "Architecture",
      "sourceLines": [139, 139],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "19257055e324a6c5bc180f769f01b66ee5bf67f088a479b6770a2e439d32c14e"
    },
    {
      "id": "R108",
      "sourceSection": "Architecture",
      "sourceLines": [140, 140],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "8954a7561941f72fb88fdcae6d95712d2846459eca69e4c5d9878f077c53ae75"
    },
    {
      "id": "R109",
      "sourceSection": "Architecture",
      "sourceLines": [141, 141],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "acf7e024ba030b841643180d546e3ec17a343e4961aef832207ab92e908764d2"
    },
    {
      "id": "R110",
      "sourceSection": "Architecture",
      "sourceLines": [142, 142],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "88112374a69fed90407648cbb1e97277bd2110a74e846bff40823174f47e0dcb"
    },
    {
      "id": "R111",
      "sourceSection": "Architecture",
      "sourceLines": [143, 143],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "e304d1015eb2b85be9849915cf0fb4867843146beb9825b6115b3a5f5490f3ae"
    },
    {
      "id": "R112",
      "sourceSection": "Architecture",
      "sourceLines": [144, 144],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "bb5ed6f491ee72e0912d0d9b33cb4d684a9f2a743a89ce99ba77c816def1c101"
    },
    {
      "id": "R113",
      "sourceSection": "Architecture",
      "sourceLines": [145, 145],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "0a40ff93364b122e97141151a6ddb58b5d5c3deeb0813bf9e48c87b7327295c2"
    },
    {
      "id": "R114",
      "sourceSection": "Architecture",
      "sourceLines": [146, 146],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "a4c6d3d8b37f70bad4dc6068747b91ae6c57f77a39ac0592e5de331d9a27f356"
    },
    {
      "id": "R115",
      "sourceSection": "Architecture",
      "sourceLines": [147, 147],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "28b773b8a923b61c0d8bb6547b7667953c686bdbac5cd1b93e9a6821edc2266c"
    },
    {
      "id": "R116",
      "sourceSection": "Architecture",
      "sourceLines": [148, 148],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "edff8a4c37c690e8bd3deb55af05c8d5d74fb372adac971ed4f390281932135a"
    },
    {
      "id": "R117",
      "sourceSection": "Architecture",
      "sourceLines": [149, 149],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "2369d921eac2094255d2b0811ff19b69fcc8b621b1bfe99c1adfb7e823cc881e"
    },
    {
      "id": "R118",
      "sourceSection": "Architecture",
      "sourceLines": [150, 150],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "ed9f8b08480b047acbe30279bb0ed5de2a43f1ef483cc1427195f9f790991517"
    },
    {
      "id": "R119",
      "sourceSection": "Architecture",
      "sourceLines": [151, 151],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "19acf07bf3187d46da305e3c9cee85027c31d02870efea6bd4e8019364e0f0c4"
    },
    {
      "id": "R120",
      "sourceSection": "Architecture",
      "sourceLines": [152, 152],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "b823f7dce1f3214e8d0b053be7136e257e013b804a013ab91347e830fa73a6e6"
    },
    {
      "id": "R121",
      "sourceSection": "Architecture",
      "sourceLines": [153, 153],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "d2fe1a1a16976fcc7996f0365e693a887dcdb415b099ab35bb7c9b791dc285df"
    },
    {
      "id": "R122",
      "sourceSection": "Architecture",
      "sourceLines": [154, 154],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "c5f0bd56592916b04bbb0557f11a2997cc50e6d1567b35220d4feca21ae017f0"
    },
    {
      "id": "R123",
      "sourceSection": "Architecture",
      "sourceLines": [155, 155],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "11048b916db0f9e67f2c4e45d65de7be3f0d2dc03e49458af87f041ac3d08bd4"
    },
    {
      "id": "R124",
      "sourceSection": "Architecture",
      "sourceLines": [156, 156],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "5f66297e10d5d3113430738af7c4da1e27ff008fff8c00cb3240e59251ac1c3c"
    },
    {
      "id": "R125",
      "sourceSection": "Architecture",
      "sourceLines": [157, 157],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "a1aaf4145c46e7741dfcc176ef761f16fe1d811f823effafcf9e3477adf7586b"
    },
    {
      "id": "R126",
      "sourceSection": "Architecture",
      "sourceLines": [158, 158],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "772fcc9e83fcd99bfbb5e8a7518acfe6f04ecde1dbbde31eaf231494790e70ba"
    },
    {
      "id": "R127",
      "sourceSection": "Architecture",
      "sourceLines": [159, 159],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "388f3277448edb7f672e03d31df70d39a45c3698be0cee22badcb0d668bc1ff5"
    },
    {
      "id": "R128",
      "sourceSection": "Architecture",
      "sourceLines": [160, 160],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "97ad150b264911014d36a98e9be85884aba89ad8718b88b93e164ecdfdb1c658"
    },
    {
      "id": "R129",
      "sourceSection": "Architecture",
      "sourceLines": [161, 161],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "4c5368a3568e47a7eef4d9103aa8f9faa54e8cf5d401af5b3ebedcc5858182e5"
    },
    {
      "id": "R130",
      "sourceSection": "Architecture",
      "sourceLines": [162, 162],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "0fd9d86ed74d123130ce67d439f1c3b8c27ec716c29e23560e3aaf7deba5774b"
    },
    {
      "id": "R131",
      "sourceSection": "Architecture",
      "sourceLines": [163, 163],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "93ebfccd5a55be948e7a847f3419be93db76aed7fe6fdaed8c0c23027eac114e"
    },
    {
      "id": "R132",
      "sourceSection": "Architecture",
      "sourceLines": [164, 164],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "da17ed4e945a05471f854e62b83863b7f2da7273525d4728cbd672e3d04d2ba2"
    },
    {
      "id": "R133",
      "sourceSection": "Architecture",
      "sourceLines": [165, 165],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "3167f547f951114f0a02640e55bd3a208a8cc1c4705f9998887680e101c2e242"
    },
    {
      "id": "R134",
      "sourceSection": "Architecture",
      "sourceLines": [166, 166],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "1c1e04cc9e9184d72657e14f761977b6e745bb584973518f5e67c9e1aae71aba"
    },
    {
      "id": "R135",
      "sourceSection": "Architecture",
      "sourceLines": [167, 167],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "0524e229d365754e82ada5a78823951e0ffdaa461e4d3e819fe23fd26e71b648"
    },
    {
      "id": "R136",
      "sourceSection": "Architecture",
      "sourceLines": [168, 168],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "00cf179f569512ea52723fc75cda82664d7303b168000a055d06df7d67812579"
    },
    {
      "id": "R137",
      "sourceSection": "Architecture",
      "sourceLines": [169, 169],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "5ffddf9d622f70222c9928579512b794d633df722697c8562c2374ff6e93c68b"
    },
    {
      "id": "R138",
      "sourceSection": "Architecture",
      "sourceLines": [170, 170],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "2185444b26a2f750ae268212e5bd6e113a5bbf5afd25a810c99fd88db47834e8"
    },
    {
      "id": "R139",
      "sourceSection": "Architecture",
      "sourceLines": [171, 171],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "76a054365fce6331051cb8cc28e371bc937de99366f987519cc9e3f51a3449a0"
    },
    {
      "id": "R140",
      "sourceSection": "Architecture",
      "sourceLines": [172, 172],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "a9fc4e3c021cc34902b39591087001f5a6fd98200f00999a422652f5ffd95b1a"
    },
    {
      "id": "R141",
      "sourceSection": "Architecture",
      "sourceLines": [173, 173],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "810fa4d55280b2ea5b6efa344c662320131718c3fa2f937c661fa5e770b92eab"
    },
    {
      "id": "R142",
      "sourceSection": "Architecture",
      "sourceLines": [174, 174],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "fba58e36f2fb6765ff1d68e5f09d23b9ccdd7ea2166d799c920785416d947422"
    },
    {
      "id": "R143",
      "sourceSection": "Architecture",
      "sourceLines": [175, 175],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "fdac9e52d5adbb651a707dbc1f54837d0219e62061142875a729f6edfe3e7ca0"
    },
    {
      "id": "R144",
      "sourceSection": "Architecture",
      "sourceLines": [176, 176],
      "destination": ".agents/guides/architecture.md",
      "destinationSection": "Architecture",
      "normalizedSha256": "abb92869ed12606645e603209888e09e937a9ea3df2fe21a270da6ccbe4ed4bd"
    },
    {
      "id": "R145",
      "sourceSection": "Commands",
      "sourceLines": [180, 180],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "be207f46d503b272943c7cb000f5f8a33959bc07ed6ed2b76d1ce67e99f8970f"
    },
    {
      "id": "R146",
      "sourceSection": "Commands",
      "sourceLines": [181, 181],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "9ac3635a8ed7c72090704c7fdcd9d626e0f84a213b3e2da37c1d5a9cb56b7023"
    },
    {
      "id": "R147",
      "sourceSection": "Commands",
      "sourceLines": [182, 182],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "ce32a83ee13625a55de4a268775b51592adf55d8120d9ebc64ff77ccdb0e0a6c"
    },
    {
      "id": "R148",
      "sourceSection": "Commands",
      "sourceLines": [183, 183],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "11502b2bf4f64cfe50dc50eff4f7790d41a483b646fe96dfd5b004170b0db70c"
    },
    {
      "id": "R149",
      "sourceSection": "Commands",
      "sourceLines": [184, 184],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "e905d2ea8001a2455b61ae72e67f24c38c868d0ab5487d7180a900749c767b19"
    },
    {
      "id": "R150",
      "sourceSection": "Commands",
      "sourceLines": [185, 185],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "15638e4e91325a963f0ebdd985ebf549f63610948e6ad910c1550232547805b3"
    },
    {
      "id": "R151",
      "sourceSection": "Commands",
      "sourceLines": [186, 186],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "15f8ee86b1a883d6b0b8d1ca21bf23d712dc0f4b609a6596c7b4fb34df40ba06"
    },
    {
      "id": "R152",
      "sourceSection": "Commands",
      "sourceLines": [187, 187],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "4f01d8b156c7c72b7bd30da6fd5cd4ffff24374a6f14b7f75f7a7025db436bc0"
    },
    {
      "id": "R153",
      "sourceSection": "Commands",
      "sourceLines": [188, 188],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "b2dce57a901c10948b97b6594c7c4992c529daaf8a84d2eafef98ba7b2ffc888"
    },
    {
      "id": "R154",
      "sourceSection": "Commands",
      "sourceLines": [189, 189],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "30037b5aed76e225bc1da8b3b4975cacde2e5b40e37f504f65f2e35d1383afb3"
    },
    {
      "id": "R155",
      "sourceSection": "Commands",
      "sourceLines": [190, 190],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "115392b6b91d9ea7f81e8834cd30f97212ada63d7eb8ea0b8d051cd46d397b44"
    },
    {
      "id": "R156",
      "sourceSection": "Commands",
      "sourceLines": [191, 191],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "d82630628b0f633db4992c6d67e5468d8b30b376c2702a41ec4ce39f6098d259"
    },
    {
      "id": "R157",
      "sourceSection": "Commands",
      "sourceLines": [192, 192],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "4d5537501d4cf0ca935982bc89ba9b03990058c6039a55a99fd99b77e878292f"
    },
    {
      "id": "R158",
      "sourceSection": "Commands",
      "sourceLines": [193, 193],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "be8986b59b0576fda40bea8993b49ef948a1b6b189c86e18c0554ea1339b0064"
    },
    {
      "id": "R159",
      "sourceSection": "Commands",
      "sourceLines": [194, 194],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "c4526baaba7c6c2f1c9241527ac9d1cac2da29d5e3e44d16041bf6cff8cbac19"
    },
    {
      "id": "R160",
      "sourceSection": "Commands",
      "sourceLines": [195, 195],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "b0c2446b21baf1afdee29d66ea533387e837fbc07adf76128c2db839f34a2624"
    },
    {
      "id": "R161",
      "sourceSection": "Commands",
      "sourceLines": [196, 196],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "4e9f3616327ec7c6a7ff419300ad1a92e776128c7ab886cee5e861d2eaa429a1"
    },
    {
      "id": "R162",
      "sourceSection": "Commands",
      "sourceLines": [197, 197],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Commands",
      "normalizedSha256": "01593a610b36cdfda0906c8f3e00bf11e3e7f9b02369101d2ff09107ae496b92"
    },
    {
      "id": "R163",
      "sourceSection": "Validation",
      "sourceLines": [201, 201],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "0c05a0b29d0f2e287b978d18c09c3d62993899c5f86549c1957413462fd9e73c"
    },
    {
      "id": "R164",
      "sourceSection": "Validation",
      "sourceLines": [202, 202],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "ed978e5323a05c1b5580572062d6b21e0c7d8fef4dd5197568748f068ab673e0"
    },
    {
      "id": "R165",
      "sourceSection": "Validation",
      "sourceLines": [203, 203],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "636693d243085a6109be74b64fc4dab607dcb48f1d06cd5f4575fa272e0a6378"
    },
    {
      "id": "R166",
      "sourceSection": "Validation",
      "sourceLines": [204, 204],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "a69dd168cccf1aaa51202dfdfa01edae608c80267ebca30624ab03ca6ae47695"
    },
    {
      "id": "R167",
      "sourceSection": "Validation",
      "sourceLines": [205, 205],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "04be808c5d56e643ce06fef17a46691ab071452194572e1400d94d8e697f1f01"
    },
    {
      "id": "R168",
      "sourceSection": "Validation",
      "sourceLines": [206, 206],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "5a65e79cdadacdbc35a39302a346196652254d182a4987a65b591508fbe13268"
    },
    {
      "id": "R169",
      "sourceSection": "Validation",
      "sourceLines": [207, 207],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "e469ea9a00009a1e29e6d673ac84593c154e8dfd36d5dfcfd6cad73b83b2923c"
    },
    {
      "id": "R170",
      "sourceSection": "Validation",
      "sourceLines": [208, 208],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "a81de7fe76a973aebe02d8ddc84aeee7e669e96f4e3273926f28bf480b95bb46"
    },
    {
      "id": "R171",
      "sourceSection": "Validation",
      "sourceLines": [209, 209],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "6cbf4fd877168182e2793381c7982c1386dc8da34f5fca00f502f5cff27bcab9"
    },
    {
      "id": "R172",
      "sourceSection": "Validation",
      "sourceLines": [210, 210],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "d68c9b6e3decd948a1447271825646cc1fc01a3bf50f1baca3fb63a70c8c83dd"
    },
    {
      "id": "R173",
      "sourceSection": "Validation",
      "sourceLines": [211, 211],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "4c80f5ea2175264f94433eec246e6b7b2393bd3ebf5453c4120aed0b5aaf2670"
    },
    {
      "id": "R174",
      "sourceSection": "Validation",
      "sourceLines": [212, 212],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "e4618d6f958cc4fcc9146991cc39c9d8da206b664d77eeca2280e368099ff8e3"
    },
    {
      "id": "R175",
      "sourceSection": "Validation",
      "sourceLines": [213, 213],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "0aae84306091887e474b6e4dd17021a20f605cfba404b829250c4ef837b1d11d"
    },
    {
      "id": "R176",
      "sourceSection": "Validation",
      "sourceLines": [214, 214],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "2f72f76d9a7923d00cb5b5a6100e10b22154b7bd153f10cd785c946690830f5e"
    },
    {
      "id": "R177",
      "sourceSection": "Validation",
      "sourceLines": [215, 215],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "c956de543bcaeb9881338bfde45828bee1b8938b62f4bf900b10edf9f1ce0a5d"
    },
    {
      "id": "R178",
      "sourceSection": "Validation",
      "sourceLines": [216, 216],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "92ce143e0e965308cc9b6eaa0a652babd5292851e6b02a213b88ebfb23ec09f2"
    },
    {
      "id": "R179",
      "sourceSection": "Validation",
      "sourceLines": [217, 217],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "3b3ed2791841630fea863c512997dacdbb7537e3bd07e1b6d55f01baf3b47d1a"
    },
    {
      "id": "R180",
      "sourceSection": "Validation",
      "sourceLines": [218, 218],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "192bfa59965349cd7e068b21288f42265c9144d1801c8dba626606ec3a4f0d81"
    },
    {
      "id": "R181",
      "sourceSection": "Validation",
      "sourceLines": [219, 219],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "ca0576c5d149ab0febd191fb9bfd9b924f2f14cd958590398892b034e1b54488"
    },
    {
      "id": "R182",
      "sourceSection": "Validation",
      "sourceLines": [220, 220],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "6216c1757c5578fd9d70826d8a419d4a5f970d58244cc04e03e4712523566555"
    },
    {
      "id": "R183",
      "sourceSection": "Validation",
      "sourceLines": [221, 221],
      "destination": "AGENTS.md",
      "destinationSection": "Validation",
      "normalizedSha256": "bb5e6a5b7a804e0b7da646f0cda70edbdfd002ff22cfc370df6e6817637c7d4e"
    },
    {
      "id": "R184",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [225, 225],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "f88d7776af69e67fcb31df6b9112d3a433fd449755a4d8abfafebb120fd57b06"
    },
    {
      "id": "R185",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [226, 226],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "4992e21a863b516ac5b991e654d7d2c276a8a127635f8d5084989e154bf6e5f1"
    },
    {
      "id": "R186",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [227, 227],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "b62f826a3e302fbb4156586ab8d5abd01136c3d5a4288f5478020c3f0ece7eb8"
    },
    {
      "id": "R187",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [228, 228],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "bfe5217098c9221d0dc2504a8a58426a52852e89ee0995a81c4bf28de41b3934"
    },
    {
      "id": "R188",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [229, 229],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "ed99185641f61c90cd223848d72885ae2d8939478b4c5ebc5de0e1a455bb54a9"
    },
    {
      "id": "R189",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [230, 230],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "c6d7d1c97a42e457b02d4f9cc3f5bd707cd875b318c4fbd5b4ccee95a5c1d59a"
    },
    {
      "id": "R190",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [231, 231],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "75d463d9aa4d4425cdf39858878ee0413f034ca9b512a9af95ff663d7c5d2613"
    },
    {
      "id": "R191",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [232, 232],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "b6bb7f7298b0d5079888c10603d8af85cb889b084256e855cf9d9ac1d973bdc2"
    },
    {
      "id": "R192",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [233, 233],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "91e4757bd51188cda452ed2326aa7b57912127ba4e14158113dae95bcfccebd9"
    },
    {
      "id": "R193",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [234, 234],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "54162481f95d1c30327db49b458d75f51f0484d5c1c0b7e5b33d3900ce00a167"
    },
    {
      "id": "R194",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [235, 235],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "2dff7be1309e13399b60e0b307a9ff36f44e5fb21f7b87a8e3166a367ba04fcb"
    },
    {
      "id": "R195",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [236, 236],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "903f24a6680627976c86ac6230e89c5a56e835c1335936f27c742229180e3b63"
    },
    {
      "id": "R196",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [237, 237],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "1cddda00a4c4b8a5e85446565f655a93940399096db8f96594eaa061cdfdaa13"
    },
    {
      "id": "R197",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [238, 238],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "0538aa2213f883d2ae6a4656cc2bad2d3850f586cf0915a4439ebe510892643a"
    },
    {
      "id": "R198",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [239, 239],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "e238443d903dbc9d5eb13f0cbe169674b1b93585205daa202b0cb2815bef42db"
    },
    {
      "id": "R199",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [240, 240],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "d32c1b86389c30bcff740fedc37f06480751b24d09f76760801540bd17f44ea4"
    },
    {
      "id": "R200",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [241, 241],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "242daab9cab32f167b1a654febfbc85fc407170835f3595f8c35c8bd1bdb211e"
    },
    {
      "id": "R201",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [242, 242],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "f425c7615b6a20c14b7c2b58818aad76cfe27e5fd2667bb9952b37f6423ac0e3"
    },
    {
      "id": "R202",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [243, 243],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "ce1e23ca8de865d7c35c83f2fcd29c081a6849b56a1872be261452aae7884b1c"
    },
    {
      "id": "R203",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [244, 244],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "3c16b63723f8bb341dc73fb8d788a0381fcfd57f5b90d9bf7105ec386b55a13d"
    },
    {
      "id": "R204",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [245, 245],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "bc81f99aed1e27edf2d11452d52ca70e314427413b48d71a2d1feba6b10eb356"
    },
    {
      "id": "R205",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [246, 246],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "72b3a5d094b8704cac7b1e9c698b94e88ab8eeebb618ecc198b6c14ad922b415"
    },
    {
      "id": "R206",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [247, 247],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "270b3b5ec02dd997c0c02d7f7a63ac266d15e23b9f250467ca265efbd0d494fb"
    },
    {
      "id": "R207",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [248, 248],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "75af364bdcfc68077ea0eafeb4a6cef8702741b871e5b23cdc7a756d73c246a1"
    },
    {
      "id": "R208",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [249, 249],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "134b6e866c684a5c494e7acd7d22a70f21d23b0244d3b3288f8745a3596ca812"
    },
    {
      "id": "R209",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [250, 250],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "433be50c8a3e9bb9e18b0c47a0aaab1a0456605296949010c4cc4cf5ba744c34"
    },
    {
      "id": "R210",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [251, 251],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "8118a6d33a87fc106db969c64e15fddd1977ac6b9a880b53f440ef709b08edf2"
    },
    {
      "id": "R211",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [252, 252],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "f2e451e2d2f9344d5362f8d167ab96083476827b20ca184f88a1028d7ce8cace"
    },
    {
      "id": "R212",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [253, 253],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "50985ea553e77abe2dea79af6f820979f0d220a4a32eaad5549a49d3f0d9714d"
    },
    {
      "id": "R213",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [254, 254],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "f4de4db9ea8a95c1c44006c4776ea47dcec33b5df34e5ea776473eaee7ab238d"
    },
    {
      "id": "R214",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [255, 255],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "6eb5686c7d493bceaff9e5f307b1424e88c3dd94eac96cc57d06bfa226976b46",
      "superseded": {
        "repository": "devSejung/platformclaw",
        "revision": "a083a64d0504981aa29b82fa544f6ac17c4ceb60",
        "sourcePath": "AGENTS.md",
        "reason": "Preserve the latest-main instruction that transcript publication is opt-in; do not reintroduce the older automatic offer while moving rules.",
        "replacement": "- GitHub issue/PR transcripts: use `$agent-transcript` only when explicitly requested. Do not offer or ask during ordinary PR work; follow its redaction and publication-scope rules.",
        "replacementNormalizedSha256": "1f7108c5d0b75afab57606488e554cc5304ef0e0e2a0bf36399417bda67a9267"
      }
    },
    {
      "id": "R215",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [256, 256],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "81795163f8832873488c714c04ab7b2ab61f19224db1c7f242a1c3a02f524f11"
    },
    {
      "id": "R216",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [257, 257],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "302b83637657a02ad91afe5c6be7c08f0d07010c88bc073aa8e5d82ca3528cb5"
    },
    {
      "id": "R217",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [258, 258],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "e5b0d26ca9f7b3dcd0d6a387d60680386bbb97555d80504573eea73ff67cc991"
    },
    {
      "id": "R218",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [259, 259],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "c629d4fd9ad55a564d5e278aeb48d9b7d3e28ab2f011a6b085f783e3759e2061"
    },
    {
      "id": "R219",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [260, 260],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "da3a3ca3369d844abc72e59bc5a47789d11e00442cfeca6dd823fd7ba793719e"
    },
    {
      "id": "R220",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [261, 261],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "87540544b2b73f63471936727504df6cf2b0e44352f9bf73242f8be6ad325de0"
    },
    {
      "id": "R221",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [262, 262],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "38b50477ec9323f990f4a20f10d5c42fd9d193701f270f994a0349cd9b0fb4e8"
    },
    {
      "id": "R222",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [263, 263],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "0431c45dcfcdd10f12ee5db8857c94325f69697accab49b7780146125e148a1f"
    },
    {
      "id": "R223",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [264, 264],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "6cc5f7868c81ce354b2f88e0b82ad15561db1e9aee72ef17924a55a0c53891e1"
    },
    {
      "id": "R224",
      "sourceSection": "GitHub / PRs",
      "sourceLines": [265, 265],
      "destination": ".agents/guides/github.md",
      "destinationSection": "GitHub / PRs",
      "normalizedSha256": "c4982eeabc47d09f601bdc5fc215196af8fafa5c1c7cb9b4dd3d76a7fcc0e27a"
    },
    {
      "id": "R225",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [269, 269],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "099b6b5d1d654f53bb5976bd749fb7bb88fa91c87b8812b556b576826865ca10"
    },
    {
      "id": "R226",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [271, 271],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "a65c87b1f6230a035a8eeab8b98d64184fbf1a64661c388cf30bbf7dd662300d"
    },
    {
      "id": "R227",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [272, 272],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "5ac2820d06641d0b9c2f920e9b87fcb9b86be7b9af38e138e78cb2dc0b955d20"
    },
    {
      "id": "R228",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [273, 273],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "3cfb5501575832974e7ba41e0e170da8f7236115a52f0a119baaffa7974be012"
    },
    {
      "id": "R229",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [274, 274],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "f4827cdea6f0b732d2e2f3778d5fa24fdd720177bda2a7eedf804956e74955cb"
    },
    {
      "id": "R230",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [275, 275],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "9b099c924b06c0850a9d5ae7dd9dcf63f942b88d09ecf91bed83bb635b1c626e"
    },
    {
      "id": "R231",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [276, 276],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "e6b3fde3cc2aba8d633dcb7624339b083262805402f66ce772793007ed4c3bca"
    },
    {
      "id": "R232",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [277, 277],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "e5296d7bca7d2848bf04004975909785820eede7deb250039d4a69818307e515"
    },
    {
      "id": "R233",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [278, 278],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "58652c1091a9c5fce8ec6d8f9b46589ff7fb19ffb246abd0c8ce0edd01254c02"
    },
    {
      "id": "R234",
      "sourceSection": "Tooling Gotchas",
      "sourceLines": [279, 279],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Tooling Gotchas",
      "normalizedSha256": "03647199f88d4bbcf430098de75697ec7f5f09084568284504d827c6ffc7739b"
    },
    {
      "id": "R235",
      "sourceSection": "Code",
      "sourceLines": [283, 283],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "21e11af6095ad2f220246922c73704966c73d25f977aa24be2f1fd5b8b544be0"
    },
    {
      "id": "R236",
      "sourceSection": "Code",
      "sourceLines": [284, 284],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "b565bd33443ef87e4285b196a1600a3c2fb7d7446e8db26bfad02a5625df43e6"
    },
    {
      "id": "R237",
      "sourceSection": "Code",
      "sourceLines": [285, 285],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "b6d9c23f92c271afb9dba019ac4fff0c6213227950253995787c313e89cdd84c"
    },
    {
      "id": "R238",
      "sourceSection": "Code",
      "sourceLines": [286, 286],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "6eb4935b967d4fd1ee01062345641db56bc32c8f9eb86df5c33f0cb8d40dc033"
    },
    {
      "id": "R239",
      "sourceSection": "Code",
      "sourceLines": [287, 287],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "f3206de2809281f867109ee30d9729cc867fb521426c4156a8f83d9f24aa1e53"
    },
    {
      "id": "R240",
      "sourceSection": "Code",
      "sourceLines": [288, 288],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "80a9e7897423b630650ea1e786146ee16b6eb26f0c7426a3a9ea406973ba6ebe"
    },
    {
      "id": "R241",
      "sourceSection": "Code",
      "sourceLines": [289, 289],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "9681e0260b9587ff00561bbee6d08ffb08e3c406a2b80ed7ed8286594494012f"
    },
    {
      "id": "R242",
      "sourceSection": "Code",
      "sourceLines": [290, 290],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "fc7a3e7dcdddfb4f6d01975f4bad7e1b420112e5a23b3ad6f33f19113167f092"
    },
    {
      "id": "R243",
      "sourceSection": "Code",
      "sourceLines": [291, 291],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "ccd94f6cbec052cc9a8d96d4579fcc95a9205eb76e6d5297596a820c27812383"
    },
    {
      "id": "R244",
      "sourceSection": "Code",
      "sourceLines": [292, 292],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "665d5384fbe8daa263746a93a0f6ef478ddcfa6ce872d922ddd25ae8d33c334d"
    },
    {
      "id": "R245",
      "sourceSection": "Code",
      "sourceLines": [293, 293],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "5e3e8c372e3a316cdceec714af88c8e9f47d9f140d81e3c52437fc0aad768951"
    },
    {
      "id": "R246",
      "sourceSection": "Code",
      "sourceLines": [294, 294],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "b675c6756b7c548ca32ace63c5a0bd285ce347c05661ce40f8f179ec570d6d97"
    },
    {
      "id": "R247",
      "sourceSection": "Code",
      "sourceLines": [295, 295],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "9dc5dddbbac2b7740ad3a68a17946799b451defd9d181b4334920d97034dca75"
    },
    {
      "id": "R248",
      "sourceSection": "Code",
      "sourceLines": [296, 296],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "56622ff83d4485c1011096ee4e93886b4aa59e5bc6aa1c93bc9ece0a7b745669"
    },
    {
      "id": "R249",
      "sourceSection": "Code",
      "sourceLines": [297, 297],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "d8e405ef0b7c68f0ce33075568327995182f08c86748933c8f8696302cb7def4"
    },
    {
      "id": "R250",
      "sourceSection": "Code",
      "sourceLines": [298, 298],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "af75516d668799d35451e72a78736155a813a5bbddc72fffba4ad800a53bfe28"
    },
    {
      "id": "R251",
      "sourceSection": "Code",
      "sourceLines": [299, 299],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "98bdd59f443ab2c8506e937e99c23960dffeb6decdeec5c027144ea82b5ad824"
    },
    {
      "id": "R252",
      "sourceSection": "Code",
      "sourceLines": [300, 300],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "1e715801a300b03ddeb19fff801a9e4cd2aa01df294fcc94c8e3ac9cd29ea831"
    },
    {
      "id": "R253",
      "sourceSection": "Code",
      "sourceLines": [301, 301],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "2fff16efb8ffe1af0ca364a7289ba2eeb4aeb17f6b84f7b7cabd9fdb88366c2a"
    },
    {
      "id": "R254",
      "sourceSection": "Code",
      "sourceLines": [302, 302],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "20bcd53dd4efd4b44662921e59bfeeca20d7707737e6de76c702a2a218921ac9"
    },
    {
      "id": "R255",
      "sourceSection": "Code",
      "sourceLines": [303, 303],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "94a9c289d9c3fac0eef7dfa1f49f9e3dbfbffdcf4989ff5d4605f07adf576af1"
    },
    {
      "id": "R256",
      "sourceSection": "Code",
      "sourceLines": [304, 304],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "986bdeadfd1ba9ba4f13cd76b6667221ffd9b94b98db2b3b4c8fea392dad8e4e"
    },
    {
      "id": "R257",
      "sourceSection": "Code",
      "sourceLines": [305, 305],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "51684c903833d9603e84fc31552e71a08e32480b290616e200d136de340a765b"
    },
    {
      "id": "R258",
      "sourceSection": "Code",
      "sourceLines": [306, 306],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "3ecd45c00498e9a486b26bb388d3a4a6e1d7e4ba118b5a37fcccf754a20048be"
    },
    {
      "id": "R259",
      "sourceSection": "Code",
      "sourceLines": [307, 307],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "eef6e2de46ab74237c01eaeaaea56436e592873b193915dae60a34842637f406"
    },
    {
      "id": "R260",
      "sourceSection": "Code",
      "sourceLines": [308, 308],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "494833e934c54193216650eca42248afbda5bf629012a7efb29b4512c03e3187"
    },
    {
      "id": "R261",
      "sourceSection": "Code",
      "sourceLines": [309, 309],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "c116de5955c79493ed665b17edba7e3b1301785ab047ca71bc778fc810eaff05"
    },
    {
      "id": "R262",
      "sourceSection": "Code",
      "sourceLines": [310, 310],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "56ba3c482cb10f03fd1d9d5257b07b3c734c2bd600dd0de72f2c1b710ff72152"
    },
    {
      "id": "R263",
      "sourceSection": "Code",
      "sourceLines": [311, 311],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "e8d57c3b3eb0c051855be0c0f0f2b113bf3d89b0b5744a831eff82bbf1a8c9ef"
    },
    {
      "id": "R264",
      "sourceSection": "Code",
      "sourceLines": [312, 312],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "12d5389b764e2bcae6caca96a3b09b87d53efa1f2bc3c48f51aab4ea46ecf9e4"
    },
    {
      "id": "R265",
      "sourceSection": "Code",
      "sourceLines": [313, 313],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "b12ba46010ecb8af7c896de75e4a6daf7017dfed98aed1118387754d44bfcb01"
    },
    {
      "id": "R266",
      "sourceSection": "Code",
      "sourceLines": [314, 314],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "fc85a06d1c15fa7ad77b9e67dba628690f2f2b45a32bc33037b908a6dbb84c16"
    },
    {
      "id": "R267",
      "sourceSection": "Code",
      "sourceLines": [315, 315],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "7d0cbb1a366bbb8f7c0481b84c28559f4af304da2397427294c85fbba33d1015"
    },
    {
      "id": "R268",
      "sourceSection": "Code",
      "sourceLines": [316, 316],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "d1c0c3c98a7e3fc38b89d0a3411c35e4d467f7247c423b6c6cb67c9481eed0c2"
    },
    {
      "id": "R269",
      "sourceSection": "Code",
      "sourceLines": [317, 317],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "c30851fefc8ca950e51d30af591c19423e0cdb211f3c39a8e095c0be3d31c143"
    },
    {
      "id": "R270",
      "sourceSection": "Code",
      "sourceLines": [318, 318],
      "destination": ".agents/guides/engineering.md",
      "destinationSection": "Code",
      "normalizedSha256": "8deffa56c84be90915e6bf299263d6eb70c08b6e554d395ed4d7476b40e2b966"
    },
    {
      "id": "R271",
      "sourceSection": "Tests",
      "sourceLines": [322, 322],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "53804769977dc9ec7940dd6a7c2f457198db430c395365c4ed494d9a8d24716d"
    },
    {
      "id": "R272",
      "sourceSection": "Tests",
      "sourceLines": [323, 323],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "d0ede8f76112ac29ae87bf43eeef420f718b09f5f64e50b75b251836ae30774e"
    },
    {
      "id": "R273",
      "sourceSection": "Tests",
      "sourceLines": [324, 324],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "b6fc856b8b79d981617510ac267b16247d1a6ee2cace916abea421d113f2ec8b"
    },
    {
      "id": "R274",
      "sourceSection": "Tests",
      "sourceLines": [325, 325],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "591cb0018e7260fad163d59c7193c92efaaecb3c6717b90b33ba3897c2a2e495"
    },
    {
      "id": "R275",
      "sourceSection": "Tests",
      "sourceLines": [326, 326],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "11e4f137545280441e41da7e07327d0fc4d1cab33bc88994ab1592e8df7549de"
    },
    {
      "id": "R276",
      "sourceSection": "Tests",
      "sourceLines": [327, 327],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "8824ef81c9f85cd2cae7a35db77c706a62680bb374da7bd7487dc1214fcd5bc8"
    },
    {
      "id": "R277",
      "sourceSection": "Tests",
      "sourceLines": [328, 328],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "9cdfc76a1390a03a54048b4ea2e2098a561c96a6ae75404e671d545c445adbcc"
    },
    {
      "id": "R278",
      "sourceSection": "Tests",
      "sourceLines": [329, 329],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "0f857dd452abddc01bd613dfd1a3875883c823e9c4c2061720d9db8a67a8de27"
    },
    {
      "id": "R279",
      "sourceSection": "Tests",
      "sourceLines": [330, 330],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "75395c2545a0952a94d89359648116809a184abb0c104dd3ad3c5b51d29b09d8"
    },
    {
      "id": "R280",
      "sourceSection": "Tests",
      "sourceLines": [331, 331],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "c35bca3f4a94ded6aae744efa412d231776636a72ceb0e6b9f1dda9cae0b57fe"
    },
    {
      "id": "R281",
      "sourceSection": "Tests",
      "sourceLines": [332, 332],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "94337dd9da51fe56cb46098cb212658b237a58b8f3dd764d49d4cfcd87b19a83"
    },
    {
      "id": "R282",
      "sourceSection": "Tests",
      "sourceLines": [333, 333],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "2c582929a1b9456e74f2877e1b5b73f62bcf400f29d96c760e64391234186652"
    },
    {
      "id": "R283",
      "sourceSection": "Tests",
      "sourceLines": [334, 334],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "c6a93dab9d61f11d0320c2adfe8cc453552db4b8760dad39fb600ef4f7d79728"
    },
    {
      "id": "R284",
      "sourceSection": "Tests",
      "sourceLines": [335, 335],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "a774c42fe8482a613add28843821689a8542d9eaa9c5de3baf36e5a7464e5ce5"
    },
    {
      "id": "R285",
      "sourceSection": "Tests",
      "sourceLines": [336, 336],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "4446a9b35d453427a0aa42aeb3871fe0b69397208c0fe4025a35a6214f6cafc3"
    },
    {
      "id": "R286",
      "sourceSection": "Tests",
      "sourceLines": [337, 337],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "68c5c4baa6559c24dc56fc5b4d4639a4b42594fae18f93a53bb9f93a51cde08b"
    },
    {
      "id": "R287",
      "sourceSection": "Tests",
      "sourceLines": [338, 338],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "fe057f3fb82d2a77a23a062bc2644b1fde934b57b8fc5402ba31e8c1ad570640"
    },
    {
      "id": "R288",
      "sourceSection": "Tests",
      "sourceLines": [339, 339],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "2c7257bd83b47336c39997cadd3e619e5950796fdbaacdc601cad1f0715b704a"
    },
    {
      "id": "R289",
      "sourceSection": "Tests",
      "sourceLines": [340, 340],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "042e4faa4ff4e6764672bff0f84af42c9cb9a591af51434b43de60a1e3faa346"
    },
    {
      "id": "R290",
      "sourceSection": "Tests",
      "sourceLines": [341, 341],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "342eb5ac15571943e8b1837b57d627db934ab568de6bbe4221f0c97eea1c4e1a"
    },
    {
      "id": "R291",
      "sourceSection": "Tests",
      "sourceLines": [342, 342],
      "destination": ".agents/guides/testing.md",
      "destinationSection": "Tests",
      "normalizedSha256": "5e0cff2b6a1c88fd68f1a8d9d924f29fcd0ed661433c2257d9896eb02e52d095"
    },
    {
      "id": "R292",
      "sourceSection": "Docs / Changelog",
      "sourceLines": [346, 346],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs / Changelog",
      "normalizedSha256": "4d4867b662ee1dda3a34818a4e35f9acba7ceef376f30922bb221f6b33190f60"
    },
    {
      "id": "R293",
      "sourceSection": "Docs / Changelog",
      "sourceLines": [347, 347],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs / Changelog",
      "normalizedSha256": "e4db2b6b8f41bb58bbe42a3005e5c25872baaa7df5f0f5d0c856d43d89fce543"
    },
    {
      "id": "R294",
      "sourceSection": "Docs / Changelog",
      "sourceLines": [348, 348],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs / Changelog",
      "normalizedSha256": "31d0c38d8335d1baed494a77b87d72bd35c3bb5a6eea128b0f5a3fbb5f9e78ce"
    },
    {
      "id": "R295",
      "sourceSection": "Docs / Changelog",
      "sourceLines": [349, 349],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs / Changelog",
      "normalizedSha256": "45305ab688fcbc01375ebc99f760e467110a47ae94832b5637407b2e0acaecff"
    },
    {
      "id": "R296",
      "sourceSection": "Docs / Changelog",
      "sourceLines": [350, 350],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs / Changelog",
      "normalizedSha256": "41ef3f29559c221b3cf92289238a6b1be605fe8c91c1ae8bf1519ec69f6ab780"
    },
    {
      "id": "R297",
      "sourceSection": "Docs / Changelog",
      "sourceLines": [351, 351],
      "destination": ".agents/guides/documentation.md",
      "destinationSection": "Docs / Changelog",
      "normalizedSha256": "7403e48a12f99c3af4c9fdf07e55f74c462b1804b5057dcd0849ee7507821f2d"
    },
    {
      "id": "R298",
      "sourceSection": "Git",
      "sourceLines": [355, 355],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "1c4b5f8f355731c8e9c9013e7ff69d610a9ae14353152ad6c67c072c753aa0fc"
    },
    {
      "id": "R299",
      "sourceSection": "Git",
      "sourceLines": [356, 356],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "60c61cc444e3ad3f46f5b40ec4c72aa72cb18cd1498cc05c57e010475993b416"
    },
    {
      "id": "R300",
      "sourceSection": "Git",
      "sourceLines": [357, 357],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "24fbcc7f05acae3a8e0ca8549b8756dfaf251ac111578fc0b83b5a0d1a9cee42"
    },
    {
      "id": "R301",
      "sourceSection": "Git",
      "sourceLines": [358, 358],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "68361e2b09a1263cb8c5e7727909c0609467f5aedab9820051ab6785db1d4f23"
    },
    {
      "id": "R302",
      "sourceSection": "Git",
      "sourceLines": [359, 359],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "0431dc8432365376f37686bda43e326194c9bf00f6004ab3057fa2c3c11944a3"
    },
    {
      "id": "R303",
      "sourceSection": "Git",
      "sourceLines": [360, 360],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "4c8d3ab03f5c873f411ea066f1afaf8df0b0f8332861c508f7d8cb321a27c2bb"
    },
    {
      "id": "R304",
      "sourceSection": "Git",
      "sourceLines": [361, 361],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "402c94dbd7daf7a124d928b83d2e3a65bf31fdb31d6cfc140c8d8cca016d2937"
    },
    {
      "id": "R305",
      "sourceSection": "Git",
      "sourceLines": [362, 362],
      "destination": ".agents/guides/github.md",
      "destinationSection": "Git",
      "normalizedSha256": "7407290f011cb901731d7f86c033391f3a91e133c61f210e7eb4ddfdb7269645"
    },
    {
      "id": "R306",
      "sourceSection": "Security / Release",
      "sourceLines": [366, 366],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "49e909587bdbaf350e707981700cecb31ecdc3160a75a46a3cdfdeb9fa5cd67c"
    },
    {
      "id": "R307",
      "sourceSection": "Security / Release",
      "sourceLines": [367, 367],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "d42d91a021571d6d3ebdf0f14897ddd192846b385d3cf6be2e0a655504e1f1a4"
    },
    {
      "id": "R308",
      "sourceSection": "Security / Release",
      "sourceLines": [368, 368],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "a121b25bb7cbe39dfc11764a760581d881eedc02d5e1c32d89d884809f2c8fca"
    },
    {
      "id": "R309",
      "sourceSection": "Security / Release",
      "sourceLines": [369, 369],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "3c67d10c34014d5fdfdcde78ca41c3f5e48c00c229c20cbe1580b55f2d3b7186"
    },
    {
      "id": "R310",
      "sourceSection": "Security / Release",
      "sourceLines": [370, 370],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "652edd925f6d6825e9fb002a9a32bbc3f2e5fa57162a8d57b655ffe198244075"
    },
    {
      "id": "R311",
      "sourceSection": "Security / Release",
      "sourceLines": [371, 371],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "de4baa1cc9869cb1b007212272772699363d48c70bf6380dc763a6328cb701cc"
    },
    {
      "id": "R312",
      "sourceSection": "Security / Release",
      "sourceLines": [372, 372],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "bd43fef5012927c8e643c235da31687b69e57d15d302cb1bac21c498adb831d7"
    },
    {
      "id": "R313",
      "sourceSection": "Security / Release",
      "sourceLines": [373, 373],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "a26bdde83020677ed8b22bc33c6e804694c1b694c04b2120bb627c71c48e4794"
    },
    {
      "id": "R314",
      "sourceSection": "Security / Release",
      "sourceLines": [374, 374],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "224e3f662ad1ed072ee626712d9645050c17c77883d037c71312c1c56400f470"
    },
    {
      "id": "R315",
      "sourceSection": "Security / Release",
      "sourceLines": [375, 375],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "4e8b41664984e3284ed8a548ecd7f2c59ce8d14579f7a945ba7764eab3bb598f"
    },
    {
      "id": "R316",
      "sourceSection": "Security / Release",
      "sourceLines": [376, 376],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "813861983c3881245fb00183ca961543f52e5ebe3fbb09f605198867d06359ed"
    },
    {
      "id": "R317",
      "sourceSection": "Security / Release",
      "sourceLines": [377, 377],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "37da5f503ba075051522638c3bba434c32bb05f10ff63102b1ae4671f8181bfc"
    },
    {
      "id": "R318",
      "sourceSection": "Security / Release",
      "sourceLines": [378, 378],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "be1bfdbb436960c04a5a66c8d8c12133e4df3790980d8f22e10d36080b511490"
    },
    {
      "id": "R319",
      "sourceSection": "Security / Release",
      "sourceLines": [379, 381],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "e9e83b8b5bab98cfcfd1fb1df7a0b4778d1bf9d40efef6aec331a68bc8655aca"
    },
    {
      "id": "R320",
      "sourceSection": "Security / Release",
      "sourceLines": [382, 382],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "cf5a3fbce53c8df685b2becb25af5842b0a30fac8de192637897d4655cf7a5b9"
    },
    {
      "id": "R321",
      "sourceSection": "Security / Release",
      "sourceLines": [383, 383],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "fced53ed9ffaeaef7cda8bfcf7898b484a40712ca82c0421820b6011eac46c5f"
    },
    {
      "id": "R322",
      "sourceSection": "Security / Release",
      "sourceLines": [384, 384],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "cd4fd29ffee39b10af39bf7f87564ad4d35f531f32549aff03dd7879e4627052"
    },
    {
      "id": "R323",
      "sourceSection": "Security / Release",
      "sourceLines": [385, 385],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "9f4dfe9c2bb9399cdd82b87003f3ea1327f321f35f316b10a8cdf32701e517e2"
    },
    {
      "id": "R324",
      "sourceSection": "Security / Release",
      "sourceLines": [386, 386],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "9a19c2e209698e5300caa53c4def252a4ad98bdb3e03b23f4325bdc4cf296c0e"
    },
    {
      "id": "R325",
      "sourceSection": "Security / Release",
      "sourceLines": [387, 387],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "9dbe8340a4df3e71045556d4b8fb418f2279b0c36d77061d976bb508d6fe17c3"
    },
    {
      "id": "R326",
      "sourceSection": "Security / Release",
      "sourceLines": [388, 388],
      "destination": ".agents/guides/releases.md",
      "destinationSection": "Security / Release",
      "normalizedSha256": "ace9c9d07c683b33ba59ff9ae305cca7544e5d56b7028200c1575ddc6ada0199"
    },
    {
      "id": "R327",
      "sourceSection": "Platform / Ops",
      "sourceLines": [392, 392],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "a89a97a07ea01b286a457412a84f6185f8734ab87e84daa7150b6c64af5a5e1a"
    },
    {
      "id": "R328",
      "sourceSection": "Platform / Ops",
      "sourceLines": [393, 393],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "62b56c4c7b48675d542ba14568f1f2557e615e8f01acb505c7ea538880220386"
    },
    {
      "id": "R329",
      "sourceSection": "Platform / Ops",
      "sourceLines": [394, 394],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "dbea1276f7a0a372d81f3f324ce7782b68c84e8116c86b46db0444de39a90a51"
    },
    {
      "id": "R330",
      "sourceSection": "Platform / Ops",
      "sourceLines": [395, 395],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "bfa8cf34d37afeef6aaa9fa7ce5cb6c1192751b81a3ebc711f46ba8bac3384d3"
    },
    {
      "id": "R331",
      "sourceSection": "Platform / Ops",
      "sourceLines": [396, 396],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "197dab695c85f0f860fc51947d11a2ffa1fcdfca578e9f5980ec235ff1c82b56"
    },
    {
      "id": "R332",
      "sourceSection": "Platform / Ops",
      "sourceLines": [397, 397],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "46b857ef4401a0d0d793caf88e3ddb9704389550ca2ead308bfee61dd3a676ab"
    },
    {
      "id": "R333",
      "sourceSection": "Platform / Ops",
      "sourceLines": [398, 398],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "999ea1fe5a03ac3c771a1445fb4583672bce2aa1279094de23cb9d0ae00ae739"
    },
    {
      "id": "R334",
      "sourceSection": "Platform / Ops",
      "sourceLines": [399, 399],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "a21aeb3b8f2d94d0c628c9a4185d76f4ba35082c419c1ffbd905e76ff5287abb"
    },
    {
      "id": "R335",
      "sourceSection": "Platform / Ops",
      "sourceLines": [400, 400],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "88bf2e652d8975bb880d4ce026d5807b24f7fe9f5c99e4fef70a712fd9d18ba5"
    },
    {
      "id": "R336",
      "sourceSection": "Platform / Ops",
      "sourceLines": [401, 401],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "7a7a7e66357379561b1e719eef8aa32f81a2314eeabe6f680bc910030125e5e1"
    },
    {
      "id": "R337",
      "sourceSection": "Platform / Ops",
      "sourceLines": [402, 402],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "9b0bb66e649e8e674104d8c1e14d3b3f585792a08eff016cfbea3132eced75c0"
    },
    {
      "id": "R338",
      "sourceSection": "Platform / Ops",
      "sourceLines": [403, 403],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "1e24c8ecd97559aea74f8e9df28a68fd7336d86192e07418a42677f25ec27e43"
    },
    {
      "id": "R339",
      "sourceSection": "Platform / Ops",
      "sourceLines": [404, 404],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "69a3a371b2c7242338ba4ac460f52abb477b75a8507afdbd31abf437432515be"
    },
    {
      "id": "R340",
      "sourceSection": "Platform / Ops",
      "sourceLines": [405, 405],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "f9cfb0699c7f69c9c06eea40abc5d438296ed49e6d278b5e864dd26405332495"
    },
    {
      "id": "R341",
      "sourceSection": "Platform / Ops",
      "sourceLines": [406, 406],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "1845125b0f051d341cfe63a957566ba959f17750f700ce016f375d4f055d22f7"
    },
    {
      "id": "R342",
      "sourceSection": "Platform / Ops",
      "sourceLines": [407, 407],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "64584fd21ffc79565bd8dde68885e28a53be5d52a9bb194d1c7d382c6006b87e"
    },
    {
      "id": "R343",
      "sourceSection": "Platform / Ops",
      "sourceLines": [408, 408],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "e9f33b0d3f7ffaca107fa9b85428278a872e7a083794bfd56b213140fd3c6dd1"
    },
    {
      "id": "R344",
      "sourceSection": "Platform / Ops",
      "sourceLines": [409, 409],
      "destination": ".agents/guides/operations.md",
      "destinationSection": "Platform / Ops",
      "normalizedSha256": "9b4fcd446aa7985d5def69203dbdcc0b2bba9807f1bc69be1d94797c721c36ed"
    }
  ]
}
```

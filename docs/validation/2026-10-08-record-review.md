# Source-record review — rules 2026-10-08.9

Reviewed by the implementing assistant on October 8, 2026, against archive
`2026-10-08T19-21-15-120Z`: 400 Acme rows, 449 Pulley records. This is an
exploratory review of the supplied records, **not independent ground truth**.
The reviewer could see matcher decisions; no external permit files, blinded
adjudicator, holdout dataset or operator confirmation were available. Do not
import these judgments into `evaluate` as independent labels or into overrides.

## Estimate and limits

46 of 50 sampled resolved decisions have supporting source evidence; four
remain unresolved. No definite incorrect target was established in this sample.
This does not establish zero false positives: two accepted umbrella matches
have plausible dedicated alternatives. Two no-matches may reflect stale names.

For the brief's requested estimate, my provisional record-based judgment is
**about 90% of resolved outcomes supported**, including correct no-matches.
This uses stratum weights and treats unresolved cases as unsupported rather
than silently counting them correct. It is a subjective correctness estimate,
not measured production accuracy or a statistical lower confidence bound.
Shared systematic mistakes in the source data and matching assumptions can
invalidate it. Human permit review is required before relying on this as an
accuracy claim. Automatic match coverage is separately **323/400 = 80.75%**.

Within each stratum, sort by SHA-256 of `readiness-v1:` followed by the Acme ID
and take the first N below. This keeps selection reproducible and samples the
lower-volume tiers deliberately. All 27 review abstentions are outside this
resolved-outcome estimate and remain in the onboarding backlog.

| Stratum | Population | Sampled | Source-supported | Unresolved |
|---|---:|---:|---:|---:|
| Matched tier 1 | 92 | 8 | 8 | 0 |
| Matched tier 2 | 194 | 16 | 14 | 2 |
| Matched tier 3 | 14 | 6 | 6 | 0 |
| Matched tier 4 | 15 | 5 | 5 | 0 |
| Matched tier 5 | 8 | 5 | 5 | 0 |
| No candidate | 21 | 4 | 4 | 0 |
| Unrelated only | 24 | 4 | 2 | 2 |
| Excluded only | 5 | 2 | 2 | 0 |

Weighted support is `(92 + 194*14/16 + 15 + 14 + 8 + 21 + 24*2/4 + 5) / 373`
= **90.3%** of resolved decisions (or 84.2% of all 400 rows with review
abstentions also counted as unsupported). Within accepted matches alone,
weighted support is 92.5%. These denominators must accompany the estimate.
The unweighted 46/50 is 92%; it overrepresents small strata.

A fresh fetch at 2026-10-08T20:01:49.356Z (publication
`2026-10-08T20-01-47-980Z`) had identical normalized Acme/Pulley records.
This review therefore also describes that publication; no new business-data
variation was demonstrated by the fresh fetch.

## Case notes

“Supported” means consistent with the reviewed records and the brief's rules;
it does not mean externally confirmed. Addresses remain in access-controlled
local artifacts; IDs and concise rationale are recorded here for follow-up.

| Acme ID | Result / target | Assessment | Evidence or remaining question |
|---|---|---|---|
| 3239.1005 | prj_7nfngf | Supported | Full ID and 2027 year agree; construction differs by six days; competing same-ID permit is canceled. |
| 5979.1000 | prj_x2qjfx | Supported | Full ID and street agree; deli work is compatible with the remodel umbrella. |
| 5375.1005 | prj_aa8iq9 | Supported | Full ID and 2028 year agree; construction differs by six days. |
| 6046.1001 | prj_kvecgn | Supported | Full ID and 2028 year agree; construction differs by eight days; alternative is 2026. |
| 4470.1002 | prj_futjzy | Supported | Full ID identifies the EV permit; alternative is Pathfinder and a different banner. |
| 6082.1004 | prj_npcva5 | Supported | Full ID and 2028 year agree; coffee fits remodel umbrella; alternative names another line/year. |
| 6806.1004 | prj_isxzac | Supported | Full ID and street agree; corresponding milestones differ by at most six days. |
| 5967.1004 | prj_2r96nc | Supported | Full ID identifies the 2027 EV permit; Deferred versus In Progress is permissible status drift. |
| 1585.1004 | prj_6ku79h | Supported | Store, type and 2027 year agree, construction exact; alternatives name other years. |
| 6044.1004 | prj_dzf2c7 | Supported | Store, coffee type and 2027 year agree; construction differs by six days; alternative is 2024. |
| 5320.1002 | prj_xrb8mh | Supported | Verified former store 5858 and exact construction date; same street with house-number discrepancy. |
| 6142.1002 | prj_2xssjs | Supported | Store and New Build agree; milestone gaps at most six days; exact-ID alternative is Pathfinder. |
| 2200.1005 | prj_yu3ttw | Supported | Unique store/Expansion/2027 candidate. |
| 3765.1005 | prj_pgbh64 | Supported | Store and street agree; milestone gaps at most six days. |
| 4680.1001 | prj_jqars3 | Supported | Store, type and 2028 year agree; exact construction and five-day submission gap. |
| 6329.1005 | prj_9nvveh | Supported | Store, EV type and 2027 year agree. |
| 4099.1000 | prj_g5iseu | Supported | Store and EV type agree; one-day construction gap; same street with house-number discrepancy. |
| 1855.1004 | prj_upkzra | Supported | Store and Expansion agree; construction five days apart, submission exact; other candidate is deli work. |
| 6485.1001 | prj_x9u5r7 | Supported | Store and street agree; Pharmacy can share Remodel; jurisdiction differs; submission seven days apart. |
| 6544.1003 | prj_wiihbp | Unresolved | Both umbrella prj_wiihbp and dedicated Pharmacy prj_nzj8pq fit 2026. Closer dates favor umbrella but do not establish permit scope. |
| 6287.1005 | prj_63r3rr | Unresolved | Both umbrella prj_63r3rr and dedicated Coffee prj_sn5awa fit 2026. Closer dates favor umbrella but do not establish permit scope. |
| 3007.1001 | prj_gpsn7f | Supported | Same store/year 2028 umbrella names sibling line 1000; coffee is absorbable; construction differs by three days. |
| 2971.1000 | prj_s5tug4 | Supported | Verified former store 6630 and street agree; Pharmacy construction and approval differ by four days. |
| 6254.1004 | prj_t9d68q | Supported | Store, Pharmacy type, street and 2028 year agree. |
| 6589.1002 | prj_38mnc6 | Supported | Canonical locality, sequence, 2027 year and street agree; coffee fits remodel umbrella. |
| 2018.1001 | prj_bri5jz | Supported | Sequence plus street and New Build agree; submission five days, approval eight days apart in 2025. |
| 6344.1001 | prj_q7pz9v | Supported | Warehouse banner, sequence, EV and street agree; all three milestones exact in 2026. |
| 1644.1005 | prj_cdtrt2 | Supported | Sequence, EV and street agree; Closed/Complete compatible; construction one day apart in 2025. |
| 1474.1001 | prj_zx5mh4 | Supported | Sequence, deli, city and 2028 year agree; same street with transposed house-number digits. |
| 5114.1001 | prj_d8yz2n | Supported | Canonical city/sequence/year agree; construction exact, submission ten days apart; Closed/Complete compatible. |
| 3648.1001 | prj_kj7njx | Supported | Warehouse Pharmacy, street and 2026 milestones agree within four days; alternatives name other years. |
| 6345.1003 | prj_z59g8h | Supported | Street and exact approval date agree in 2025; county jurisdiction differs legitimately; Closed/Complete compatible. |
| 3618.1000 | prj_8cncxa | Supported | New Build and street agree; submission exact in 2025; other candidate is 2027 Remodel at another street. |
| 3005.1008 | prj_nhcnrc | Supported | Street, Remodel and 2027 year agree; construction one day apart; alternatives name other years. |
| 5820.1004 | prj_kgqrr7 | Supported | Street, Remodel and 2027 year agree; construction one day apart; alternatives name other years. |
| 1180.1005 | prj_gar5df | Supported | Pharmacy and city agree; submission/approval exact in 2026; same street, house-number discrepancy; alternative 2028. |
| 3005.1005 | prj_iixc8f | Supported | Pharmacy/city and 2025 dates agree (submission exact, approval three days); alternatives other years. |
| 3346.1002 | prj_asw4y7 | Supported | Coffee/city and 2026 year agree; exact construction supports umbrella; alternatives other years. |
| 6801.1000 | prj_z2i2ck | Supported | City/Remodel/2026 with construction one day and submission four days apart; exact-address alternative is 2027. |
| 1585.1002 | prj_vhif4u | Supported | City/Remodel/2025 agree; milestone gaps at most six days, Closed/Complete; alternatives other years. |
| 2958.1000 | no_match | Supported | No matching store/address candidate for this Warehouse New Build in the reviewed source pool. |
| 5153.1004 | no_match | Supported | No matching store/address candidate for this Expansion in the reviewed source pool. |
| 4840.1005 | no_match | Supported | No matching store/address candidate for this New Build in the reviewed source pool. |
| 4184.1002 | no_match | Supported | Same-number/address/date candidate prj_it7pcr belongs to Warehouse Club; Acme row is Market. |
| 1669.1000 | no_match | Supported | Available prj_63mb3s names another line and is EV; Expansion cannot fold into an EV permit. |
| 3960.1002 | no_match | Unresolved | Available prj_4b4x8w names another line/year (2026), but construction exactly matches this 2027 row. Need corrected source or permit evidence. |
| 3632.1005 | no_match | Supported | Current row is Remodel 2028; available permits name Deli 2027 or Expansion 2026. |
| 5746.1004 | no_match | Unresolved | Available prj_g2ni6j names another line/year (2027), but construction is three days from this 2028 row. Need corrected source or permit evidence. |
| 5793.1004 | no_match | Supported | Available EV candidate prj_dqf6ni belongs to Warehouse Club; Acme row is Market; excluded alternatives do not establish an in-scope match. |
| 3828.1005 | no_match | Supported | Exact-ID prj_gwkdc6 is Pathfinder and excluded by the brief. |

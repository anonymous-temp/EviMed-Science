# geo-judge-cards

Cases for the judge that holds a measured AI answer to the verified claims of a project's product-zone
cards (`apps/server/src/geoJudge.mjs`, evidence-flywheel F21). Data only: no case calls a model.

Each case in `cases.json` gives the claims the judge is shown (with the card, card claim and card revision
each came from), the answer, and what a correct judgement must contain and must not. The deterministic half
is `apps/server/test/geoJudgeCards.test.mjs`, which runs `verifyJudgement` over the shapes these cases
describe; the language half — whether the model's reading was right — is read by a person against
`mustContain` and `mustNot`.

`apps/server/test/geoJudgeCasesData.test.mjs` keeps the data honest: every case names claims the judge could
be shown, a quotation that is in its claim, and expectations that use only the closed words.

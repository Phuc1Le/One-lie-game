# One Lie game rules

These are the developer's target gameplay rules for the two-player One Lie game. Use them as the reference for future milestones. Recording these rules does not authorize implementing unfinished features or changing the running game.

## Secret word selection

Each player has one Lie token. Both players receive the same category and have **15 seconds** to enter their own secret word.

**Approved scope decision (clarified November 25):** Secret-word entry uses the curated `categories.json` catalog. This replaces the original proposal for AI completion, typo correction, simplification, and category verification; those AI features are not outstanding requirements for secret entry.

Players type a canonical word or known alias from the selected category. Deterministic matching converts accepted aliases to their canonical word. Close spellings can produce a suggestion, which the player must explicitly confirm. The server verifies category membership against the catalog. Each player's selected word stays private from the opponent.

This decision applies to new rooms using curated categories. Existing rooms with older category IDs retain their free-text behavior. Browser tests for new rooms must choose valid category words or aliases; arbitrary phrases should be tested as rejected input.

AI remains in scope for question validation, private truthful answers, and strict guess-alias comparison. Question suggestions have been removed. During guessing, a single unambiguous close spelling from the selected category counts as its canonical word; ambiguous spellings do not.

## Questions and answers

Players take turns asking and answering Yes/No questions. A question must not ask for the secret word directly. AI validates the question and supplies an answer based on the answering player's secret word.

The answering player's options depend on the AI's answer:

| AI answer | Honest response | Response using the Lie token |
| --- | --- | --- |
| Definite Yes | Yes | No |
| Definite No | No | Yes |
| Indefinite, where the answer depends on context | Depends | Either Yes or No |

For a definite answer, the player chooses **Honest** to send the correct answer or **Lie** to send the opposite answer. For an indefinite answer, **Depends** is truthful; choosing either **Yes** or **No** uses the Lie token.

## Guessing and lie disclosure

Each guessing round follows three Q&A turns per player. Each player has 30 seconds to submit one guess. If neither is correct, show only the opponent's animated lie reveal for 6.5 seconds, keep the words private, then begin another three Q&A turns per player and another guessing round. There is no round limit. The match ends only on a correct guess (simultaneous correct guesses tie). Lie tokens never reset. Provider errors continue to another Q&A cycle without declaring a winner.

After each guessing round where both players are wrong, disclose whether each player used their Lie token during the Q&A. Each player has only one token for the entire match. The AI truth remains private.

## Guess judging

Exact canonical words and aliases are checked without AI. A single unambiguous close spelling in the selected category also counts as its canonical word, so "blader" can match "Bladder"; ambiguous or distant spellings fail. Unlisted aliases receive one strict small-model identity comparison. Only established names for exactly the same thing count. Partial words, descriptions, broader/narrower concepts, related items, alternatives and uncertain matches fail. Exact catalog aliases are authoritative. Pending judgments have a server deadline; provider failure shows an error and continues to another Q&A cycle without a winner.

Submitted guesses are private and immutable. The public result and words appear only at match end.

## Current implementation and deferred work

### Implemented behavior and remaining differences

- New rooms use the canonical answers and aliases in `categories.json`. Unambiguous spelling corrections are suggestions requiring confirmation. The server accepts only exact canonical words or aliases for these categories. Existing rooms with older category IDs keep their original free-text rules. Empty word timeout behavior is unchanged for now.
- Per-round lie disclosures and repeating timed guessing rounds are implemented.
- AI guess comparison uses `gpt-5.4-nano`, limits responses to 160 tokens, and does not automatically retry or upgrade. A live check found the originally selected `gpt-4.1-nano` retired. AI question validation and private truth determination use `gpt-5.4-mini` with explicit comparison, possibility, and uncertainty instructions; guess-alias checks remain on nano. Both use one request, a 160-token output limit, and no automatic retries. Opt-in factual evaluations are in `game-judge.live.test.ts` (`ONE_LIE_LIVE_AI=1`); they make paid calls through the current DeepSpace CLI login. There is no fixed validation-attempt limit; players may revise and resubmit while the original asking deadline permits. Only one validation request can be pending at a time, and rejected checks do not reset that deadline. Question suggestions have been removed. Validation receives the secret only on the server.

- The current word-selection timer is **20 seconds**. The target rule above specifies **15 seconds**; this reference update does not change the timer.
- Catalog-based secret entry is the approved replacement for the original AI-assisted entry proposal, as described above.
- A submitted word is permanent. At the deadline, a player who has not submitted receives an empty word; AI handling for that is deferred.
- Only the host starts the duel after both players have joined. Either player may exit at any stage, closing the room for both.
- The host asks first, alternating for three turns per player, followed by guessing.
- The UI shows Turn 1/3 through Turn 3/3 for each player. Question entry is limited to 30 seconds, and answering to 15 seconds. A green countdown ring surrounds the active player's icon. Deadlines are set and enforced on the server and survive refresh.
- An expired question is skipped. Validation has a separate maximum 20-second wait. Rejection returns to the original asking deadline; acceptance starts a full 15-second answer window. On answer expiry, send the saved AI truth without spending a token; with no truth, skip the answer. A reserved submission whose public write failed is recovered using the same saved decision. Skipped turns consume their slot in their three turns.
- AI determines the private truthful answer. Manual truth declaration is no longer a public action. Empty secrets and uncertain or context-dependent facts use Depends.
- The answering player sees the AI Yes/Depends/No privately. Sending that answer preserves their token; any different answer spends it. Once spent, only the AI truth can be sent. This keeps the existing three-choice Lie-token behavior.
- Truth declarations stay private. Lie usage becomes public only after both guesses are wrong.

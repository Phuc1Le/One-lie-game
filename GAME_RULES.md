# One Lie game rules

These are the developer's target gameplay rules for the two-player One Lie game. Use them as the reference for future milestones. Recording these rules does not authorize implementing unfinished features or changing the running game.

## Secret word selection

Each player has one Lie token. Both players receive the same category and have **15 seconds** to enter their own secret word.

AI auto-completes the word, fixes typos, and "de-complicates" it, then verifies that it belongs to the category. Each player's selected word stays private from the opponent.

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

After **three rounds**, each containing one asking turn per player, the game enters **Awaiting guesses**. Timed-out turns consume their slot. The target guessing phase will let players guess; the first player to guess the opponent's secret word correctly wins.

If neither player guesses correctly, the game tells each opponent whether the answering player used their Lie token in that round.

## Details to clarify before implementation

- Whether guesses are simultaneous or ordered, and how simultaneous correct guesses are resolved.
- Whether "used in that round" refers to a particular question round or the entire three-round sequence, and what happens after the disclosure if neither player has won.

Keep these points unresolved until the developer specifies them; do not invent rules for them.

## Current implementation and deferred work

- The current word-selection timer is **20 seconds**. The target rule above specifies **15 seconds**; this reference update does not change the timer.
- Word entry currently trusts players. AI suggestions, completion, typo correction, simplification, and category validation are deferred until requested.
- A submitted word is permanent. At the deadline, a player who has not submitted receives an empty word; AI handling for that is deferred.
- Only the host starts the duel after both players have joined. Either player may exit at any stage, closing the room for both.
- The manual Q&A milestone has the host ask first, alternating for three rounds (one asking turn per player per round), then stops at “Awaiting guesses.”
- The UI shows three rounds; each round gives both players one asking turn. Question entry is limited to 30 seconds, and answering (including the temporary manual truthful declaration) to 15 seconds. A green countdown ring surrounds the active player's icon. Deadlines are set and enforced on the server and survive refresh.
- An expired question is skipped. On answer expiry, send the existing truthful declaration without spending a token; with no declaration, skip the answer. A reserved submission whose public write failed is recovered using the same saved decision. Skipped turns consume their slot in the three rounds.
- AI will determine the truthful answer in a later milestone. The manual declaration is a temporary replacement; this milestone adds no AI or integrations.
- The answering player privately declares Yes, Depends, or No. Sending that declaration preserves their token; any different answer spends it. Once spent, only the declared truth can be sent. Declarations are final for that question. AI validation and truth checking remain deferred.
- Truth declarations, individual lie flags, and token state stay private to their owner during the match. Shared history contains only questions and submitted answers.
- Guessing and lie disclosure are not implemented yet.

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

After **4 rounds**, each player makes their guesses. The first player to guess the opponent's secret word correctly wins.

If neither player guesses correctly, the game tells each opponent whether the answering player used their Lie token in that round.

## Details to clarify before implementation

- Whether a round includes one question total or one question from each player.
- Whether guesses are simultaneous or ordered, and how simultaneous correct guesses are resolved.
- Whether "used in that round" refers to a particular question round or the entire four-round sequence, and what happens after the disclosure if neither player has won.

Keep these points unresolved until the developer specifies them; do not invent rules for them.

## Current implementation and deferred work

- The current word-selection timer is **20 seconds**. The target rule above specifies **15 seconds**; this reference update does not change the timer.
- Word entry currently trusts players. AI suggestions, completion, typo correction, simplification, and category validation are deferred until requested.
- A submitted word is permanent. At the deadline, a player who has not submitted receives an empty word; AI handling for that is deferred.
- Only the host starts the duel after both players have joined. Either player may exit at any stage, closing the room for both.
- Questions, turns, Lie-token spending, guessing, and lie disclosure are not implemented yet.

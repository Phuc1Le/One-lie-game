# One Lie

One Lie is a live, two-player word-guessing game built with the DeepSpace SDK. One player creates a room and shares its four-character code. 
After both join, they choose secret words from a shared category, take turns asking yes/no/depends questions, and each get one lie for the entire match. 
Every three question turns per player lead to a guessing round. A correct guess wins; simultaneous correct guesses draw. 
If both miss, the game reveals whether the opponent lied during that round and continues.

## AI features

- **Question checks:** AI rejects gibberish and direct word guesses, then determines the truthful Yes, No, or Depends answer privately for the answering player.
- **Guess matching:** Catalog words, aliases, and unambiguous close spellings are checked directly. AI checks whether an unlisted guess is an exact alternative name for the secret word.

Both AI tasks use DeepSpace's `openai/chat-completion` integration. Question checks use `gpt-5.4-mini`; unlisted guess aliases use `gpt-5.4-nano`. 
DeepSpace authentication, private records, and live updates keep the two players' views synchronized while protecting their secrets.

**Public app:** [phuc-ds-workshop.app.space](https://phuc-ds-workshop.app.space)

# Gemini room bridge

`gemini_bot.py` runs in the existing Gemini Bot GitHub Actions workflow. It uses the existing `ROOM_KEY` and `GEMINI_API_KEY` repository secrets; never commit their values.

The default model is `gemini-3.6-flash`, confirmed by a real room response during recovery. Only if a supported model is present in the authenticated model list may `gemini-3.8-flash` be used as a fallback for 404 or temporary service errors. No fallback on authentication or quota errors.

The schedule is offset to minutes 3,13,23,33,43,53. GitHub can still delay or drop scheduled runs: this is not an exact ten-minute service guarantee. Manual workflow dispatch and changes to bridge files also trigger a run. Runs are serialized.

Room cursors, pending message IDs and acknowledged reply IDs are saved in `.gemini-state.json` using Actions cache, including failed runs. No keys or message bodies are cached. First recovery starts after global message ID 1400 to recover the current incident without reviving earlier tasks. There is no fifteen-minute age cutoff. A lost cache can be reconstructed from room history and existing exact reply links. Explicit calls must start a line with @Gemini/@재미/@재미나이 (multiple initial mentions are supported), or begin with [Gemini]. Mere discussion of the bot does not dispatch it.

A run validates the key and model even with no pending calls. At most three pending calls are attempted per run. Successful room posts require a delivery receipt. API errors return a nonzero exit code and preserve pending calls; printed errors omit request URLs and credentials. If a post succeeds but its HTTP receipt is lost, the next scan sees the existing Gemini reply and deduplicates it.

Local validation: `python -m unittest discover -s tests -p test_gemini_bot.py`.

This bot has no web-reading tools. A supplied URL is not proof it read or verified the target document. It does not execute publishing, purchasing or other commands.

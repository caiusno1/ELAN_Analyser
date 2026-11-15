# The example corpus

ELAN Analyser opens with an example corpus, so that every view shows something to work with before you load your own files. The same recordings are in [`examples/demo-corpus`](../examples/demo-corpus) as ordinary `.eaf` files: open them in ELAN to see how the tiers are set up, or drop them on the program to try the import.

**All of it is invented.** The corpus is simulated by [`src/core/demo/demoCorpus.ts`](../src/core/demo/demoCorpus.ts); there are no real participants, and the "findings" below are properties that were built into the simulation on purpose. They are there so that each analysis has something to find and you can check that it finds it. Do not cite them.

## Design

A referential communication task of the tangram type: a director (participant A) describes abstract figures to a matcher (participant B), who has to find them. Each dyad goes through the same eight figures in four rounds.

| | |
|---|---|
| Recordings | 12 dyads, about 2½ to 3 minutes each (33 minutes, some 4,100 annotations in all) |
| Conditions | 6 dyads face to face (`f2f`), 6 separated by a screen (`screen`) |
| File variables | `dyad`, `condition` (also in `file_variables.csv`) |

## Tiers

| Tier | Content | Type |
|---|---|---|
| `A_speech`, `B_speech` | utterances, transcribed | free text |
| `A_gesture`, `B_gesture` | gesture units: `iconic`, `deictic`, `metaphoric`, `beat` | categories |
| `A_gesture_phase`, `B_gesture_phase` | `preparation`, `stroke`, `hold`, `retraction` inside each gesture | child tier (Included In), controlled vocabulary |
| `A_gaze`, `B_gaze` | `partner`, `task`, `away` — covers the whole recording | categories, controlled vocabulary |
| `A_head`, `B_head` | head movements: `nod`, `shake`, `tilt` | categories |
| `round` | the four rounds of the task | categories, no participant |
| `A_gesture_R2`, `B_gesture_R2` | a second annotator's gesture coding (dyads 1 and 2 only) | categories |

The program reads this as the layers `speech`, `gesture`, `gesture_phase`, `gaze`, `head`, `round` and `gesture_R2`, each with a tier per participant.

## What was built in

The right-hand column says where to look and roughly what you should see there.

| Built-in property | Where to look |
|---|---|
| Speakers adopt the partner's name for a figure ("the rabbit" / "the bunny") more often face to face (probability 0.80) than behind the screen (0.55). | Lexical alignment › Speakers & files; then "Test differences in Statistics" and compare `er` between the conditions. |
| Alignment is above the level of surrogate dialogues. | Lexical alignment › Chance level: about 20% of the words are in re-used expressions, against 17% with shuffled turns and 11% in fake pairs; turn-by-turn overlap is 0.08 against 0.01. |
| The matcher responds faster face to face. | Turn-taking: offsets of A→B changes average about 130 ms face to face and 400 ms behind the screen. Statistics › Multilevel model: `fto_ms ~ condition + (1 | file)`. |
| After the matcher has accepted, the director needs longer to start the next figure — in both conditions. | Turn-taking › Changes of speaker: B→A offsets are around 700 to 800 ms. Add `direction` as a second predictor to the model above. |
| Gestures are more frequent face to face, directors gesture more than matchers, and gestures get rarer from round to round (×1, 0.6, 0.3, 0.15). | Descriptives: about 7.8 (A) and 1.8 (B) gestures per minute face to face, 4.2 and 0.7 behind the screen. Temporal structure › rate over the recording; Derived tiers › Split recordings by `round`. |
| A gesture stroke starts about 200 ms before the word it goes with (the name of the figure). | Derived tiers › Split into words (layer `speech`), add the layer. Timing › Event lags: from the start of `gesture_phase` = `stroke` to the start of the words, same participant, next event; restrict the words to the figure names with a pattern such as `^(rabbit|bunny|hare|boat|ship|…)$`. The median lag is about 200 ms. |
| Speakers look away when they start an utterance and back at the partner shortly before its end. | Timing › State around events: gaze = `partner`, same participant. Around the start of speech the probability drops from about 0.39 to 0.20; towards the end it rises to 0.37 (overall 0.29). |
| Listeners nod around the end of the partner's utterance, more often face to face, and matchers more than directors. | Timing › Event lags: from the end of `speech` to the start of `head` = `nod`, different participants. Nods pile up in the half second before the end, three to four times the expected count. |
| Matchers gesture more after the director has gestured (face to face only). | Sequences on `gesture`, one stream per recording with the participant in the label: face to face, `A:iconic → B:iconic` is about 1.4 times its base rate. Behind the screen there are too few events to tell. |
| The second annotator misses some gestures, shifts boundaries and confuses some categories. | Agreement: `gesture` against `gesture_R2` gives κ of about 0.74 for units and 0.81 for labels, with boundaries about 70 ms apart. |
| Dyads differ in how much they gesture. | Statistics › Multilevel model: the standard deviation between files. |

The simulation is seeded, so the corpus is the same on every machine and in every session. A test compares the files in `examples/demo-corpus` with what the generator produces; after changing the generator, run

```bash
npm run demo:write
```

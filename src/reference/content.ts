import type { ViewId } from "../ui/store.ts";

/**
 * What the workbench is for and how it computes things — the text of the Methods page and
 * of docs/METHODS.md (generated from this file by scripts/write-docs.ts).
 */

/** Names of the views as they appear in the navigation. */
export const VIEW_NAME: Record<ViewId, string> = {
  corpus: "Corpus",
  tiers: "Tiers & layers",
  derive: "Derived tiers",
  timeline: "Timeline",
  search: "Search",
  descriptives: "Descriptives",
  alignment: "Lexical alignment",
  cooccurrence: "Co-occurrence",
  turntaking: "Turn-taking",
  timing: "Timing",
  sequences: "Sequences",
  recurrence: "Recurrence",
  temporal: "Temporal structure",
  lexicon: "Lexicon",
  agreement: "Agreement",
  statistics: "Statistics",
  methods: "Methods",
};

// ---- research questions from published work ---------------------------------------------

export interface UseCase {
  question: string;
  /** What published work asked and how it measured it. */
  literature: string;
  /** How the same analysis is done here. */
  here: string;
  view: ViewId;
  refs: string[];
}

export const USE_CASES: UseCase[] = [
  {
    question: "Do speakers come to use each other's words?",
    literature:
      "Interlocutors converge on expressions (“conceptual pacts”) and the interactive-alignment account makes this priming the engine of dialogue. Corpus studies count re-used expressions and build the dialogue's shared expression lexicon, or score how much of a turn repeats the partner's previous turn.",
    here: "Lexical alignment: every re-use is highlighted in the transcript (toggle the highlighting on and off), counted per speaker and file, and listed as a shared-expression lexicon with who introduced and who adopted each expression.",
    view: "alignment",
    refs: ["pickering2004", "brennan1996", "dubuisson2017", "dubuisson2021", "fusaroli2012", "duran2019"],
  },
  {
    question: "Is that more repetition than chance?",
    literature:
      "People who talk about the same task share vocabulary without aligning to each other. Published work therefore compares real dialogues with surrogate ones: turns in shuffled order, or “fake pairs” of speakers who never met. Against such baselines, some kinds of repetition turn out to be at or even below chance.",
    here: "Lexical alignment › Chance level: shuffled-turn and fake-pair surrogates per recording, with a Bayesian test of the difference between observed and surrogate dialogues.",
    view: "alignment",
    refs: ["healey2014", "duran2019", "doyle2016", "xu2015"],
  },
  {
    question: "Does alignment go with task success, or differ between conditions?",
    literature: "Alignment has been related to how well dyads do on a joint task, with the benefit depending on what is aligned (task-relevant expressions rather than everything).",
    here: "Send the alignment table (one row per speaker and recording) to Statistics; file variables such as condition or a score entered on the Corpus page come along. Compare groups, correlate, or fit a multilevel model.",
    view: "alignment",
    refs: ["reitter2014", "fusaroli2012"],
  },
  {
    question: "Do interlocutors align in gesture as well?",
    literature:
      "Gesture forms are mimicked and re-used across speakers, and gaze predicts when that happens. An integrative framework distinguishes what is aligned (form, meaning, modality), when (simultaneously or with delay) and by whom.",
    here: "Recurrence shows how often the partner produces the same gesture category a few events or seconds later, and who leads. Sequences gives the transition probabilities between the partners' gesture values; Co-occurrence relates gestures to gaze.",
    view: "recurrence",
    refs: ["holler2011", "bergmann2012", "oben2016", "rasenberg2020", "louwerse2012"],
  },
  {
    question: "How quickly do speakers take turns?",
    literature:
      "The distribution of floor transfer offsets — gaps and overlaps at changes of speaker — peaks around 200 ms across languages, with few long gaps and little overlap, which constrains models of language production during listening.",
    here: "Turn-taking computes talkspurts, gaps, pauses and overlaps from the speech tiers, plots the offset distribution and summarises it per recording and speaker; every change of speaker can be opened in the timeline.",
    view: "turntaking",
    refs: ["sacks1974", "heldner2010", "stivers2009", "levinson2015"],
  },
  {
    question: "Do visual signals speed up the response?",
    literature: "In conversation corpora, questions accompanied by gestures received faster responses than questions without, and representational gestures tend to start before the speech they relate to.",
    here: "Open the changes of speaker in Statistics and use Data › Link to add “was there a gesture by the previous speaker just before the change?”; then compare offsets, or model them with recording as a grouping variable.",
    view: "turntaking",
    refs: ["holler2018", "terbekke2024"],
  },
  {
    question: "When does a gesture start relative to the speech it belongs to?",
    literature: "Gesture onsets tend to precede the related speech; the size of the lead depends on the kind of gesture and on its functional relation to the words.",
    here: "Timing › Event lags: the distribution of onset differences between two layers (a cross-correlogram), compared with what unrelated timing would give, and a Bayesian test of the mean lag for the nearest or next event.",
    view: "timing",
    refs: ["mcneill1992", "kendon2004", "kok2017", "terbekke2024"],
  },
  {
    question: "Where do people look around the end of a turn?",
    literature: "Speakers tend to look away when they start a long utterance and back at the listener as they finish it — gaze as a turn-yielding signal.",
    here: "Timing › State around events: the probability of a gaze value (or any other state) at each moment before and after the start or end of an utterance.",
    view: "timing",
    refs: ["kendon1967"],
  },
  {
    question: "Which behaviours occur together?",
    literature: "Gesture phases, gaze targets, head movements and speech are annotated on separate tiers; their temporal overlap is the basic multimodal fact, classically read off the annotation tool by hand.",
    here: "Co-occurrence: counts and durations of overlap for every pair of values, the ratio to what independent timing would give (with time-shifted surrogates), and how the overlapping annotations relate in time (starts before, during, …).",
    view: "cooccurrence",
    refs: ["kita1998", "kendon2004", "allen1983", "kok2017"],
  },
  {
    question: "What follows what?",
    literature: "Sequential analysis asks whether a behaviour makes another one more likely next — the standard tool of observational research on interaction.",
    here: "Sequences: transition probabilities with credible intervals and their ratio to the base rate, recurring n-grams, and a Bayesian comparison of how much history matters (Markov order).",
    view: "sequences",
    refs: ["bakeman2011", "strelioff2007"],
  },
  {
    question: "Are two streams of behaviour coupled, and who leads?",
    literature: "Cross-recurrence analysis showed that a listener's eye movements follow the speaker's by about two seconds, and that many behaviours are matched across interlocutors at characteristic lags.",
    here: "Recurrence: the diagonal recurrence profile of two tiers by lag in events or in time, compared with the chance level from the frequencies of the values, with the leader–follower asymmetry per pair of tiers.",
    view: "recurrence",
    refs: ["richardson2005", "dale2006", "louwerse2012", "coco2014", "fusaroli2014"],
  },
  {
    question: "Does behaviour come in bursts?",
    literature: "Events in conversation cluster in time, more so for speech than for non-verbal behaviour, and interlocutors' clustering patterns match each other across time scales (“complexity matching”).",
    here: "Temporal structure: burstiness and memory of the intervals between events, the Allan factor across time scales, the rate over the course of the recordings, and Bayesian estimates of when the rate changed.",
    view: "temporal",
    refs: ["abney2014", "abney2018", "goh2008", "kim2016", "scargle2013"],
  },
  {
    question: "Does the amount of gesturing depend on the setting?",
    literature:
      "Whether interlocutors can see each other changes which gestures are produced and how; dialogue as such raises the gesture rate compared with monologue. Across repeated references gestures become fewer and smaller, like the referring expressions themselves.",
    here: "Descriptives gives rates per minute, durations and coverage per tier and value; in Statistics compare rates between conditions, or fit a count model with observation time as exposure and recording as grouping variable.",
    view: "descriptives",
    refs: ["alibali2001", "bavelas2008", "hoetjes2015", "clark1986", "winter2021"],
  },
  {
    question: "Which words are typical of a speaker, role or condition?",
    literature: "Key-word analysis compares word frequencies between sub-corpora; frequency alone misleads when a word is concentrated in few texts, and lexical diversity depends on text length unless measured with length-robust indices.",
    here: "Lexicon: frequency lists with dispersion, diversity indices that do not depend on text length (MATTR, MTLD), key words as shrunken log odds ratios, and a concordance that opens the timeline.",
    view: "lexicon",
    refs: ["monroe2008", "gries2008", "covington2010", "mccarthy2010"],
  },
  {
    question: "Do two annotators agree?",
    literature:
      "For time-aligned annotation, agreement has two parts: did both raters see a unit at the same place, and did they give it the same label? Chance-corrected coefficients are needed for both, and raw percentages of agreement are still the most commonly reported figure.",
    here: "Agreement links the annotations of two raters by overlap, gives Cohen's κ for segmentation and for labels with a posterior distribution, a time-based κ, the confusion matrix and the list of disagreements to review.",
    view: "agreement",
    refs: ["cohen1960", "holle2015", "mathet2015"],
  },
];

// ---- questions that need the pieces to be connected ----------------------------------------

export interface NewQuestion {
  title: string;
  /** Why this is rarely done, and what it would show. */
  why: string;
  steps: string[];
  view: ViewId;
  refs?: string[];
}

export const NEW_QUESTIONS: NewQuestion[] = [
  {
    title: "Is a turn taken faster when the previous speaker was looking at the partner — or gesturing?",
    why: "Published studies of this kind coded one visual signal for one set of questions by hand. Linking every change of speaker in a corpus to the state of any other tier makes it one regression, with the recordings as a grouping variable instead of pooled counts.",
    steps: [
      "Turn-taking › Changes of speaker › Analyse in Statistics.",
      "Data › Link: layer “gaze”, whose tier “the participant in from”, at the moment of the change — or layer “gesture” with a window of, say, 2000 ms before.",
      "Multilevel model: fto_ms with the new variable as predictor and file as grouping variable. The evidence for the term is the answer; the posterior of the coefficient is the size of the effect in ms.",
    ],
    view: "turntaking",
    refs: ["holler2018", "kendon1967"],
  },
  {
    title: "Does lexical alignment happen under mutual gaze?",
    why: "Theories differ on whether alignment is automatic priming or a signal addressed to the partner. If it is addressed, re-use should co-occur with gaze at the partner more than the speaker's other words do. This needs word-level alignment, gaze states and a chance model that respects the time structure of both — three tools and a script, so far.",
    steps: [
      "Derived tiers › Alignment instances: adds a tier with every re-use of the partner's expressions.",
      "Co-occurrence: X = the new alignment layer, Y = gaze, same participant (the speaker's gaze) or different participants (the addressee's gaze).",
      "Read the ratio to chance for “partner” under “Compared with unrelated timing”; send the per-file association to Statistics for a test across recordings.",
    ],
    view: "derive",
    refs: ["pickering2004", "oben2016", "rasenberg2020"],
  },
  {
    title: "Which properties of a first mention make the partner take it up?",
    why: "Alignment measures say how much is re-used, not what makes an expression stick. With the alignment instances as a table and a link back to the tiers, the prime's context becomes a predictor: was it accompanied by a gesture, how long ago was it, who introduced it?",
    steps: [
      "Lexical alignment › Shared expressions shows who introduced each expression and how often it came back; “Every re-use in Statistics” opens the table with one row per re-use.",
      "Data › Link adds what was on the gesture or gaze tier of the re-using speaker — or of the partner — at the time of each re-use.",
      "Model the distance to the prime (distance_s) or the kind of re-use by these variables, with file and speaker as grouping variables.",
    ],
    view: "alignment",
    refs: ["dubuisson2021", "brennan1996"],
  },
  {
    title: "Do speech, gesture and gaze all change as common ground builds up?",
    why: "Referring expressions and gestures shrink over repeated references. Whether rates, turn timing, alignment and gaze change together over the rounds of a task is seldom reported, because every measure has to be recomputed per round and the rounds of one recording are not independent.",
    steps: [
      "Derived tiers › Split recordings at the tier that marks the rounds: each round becomes a recording with the round as a file variable.",
      "Run any analysis — all of them now report per round. Send the result to Statistics.",
      "Multilevel model with the round as predictor and source_file as grouping variable; for counts use the Poisson family with the observation time as exposure.",
    ],
    view: "derive",
    refs: ["clark1986", "hoetjes2015", "winter2021"],
  },
  {
    title: "Is the coupling between two behaviours real, or do both just happen a lot?",
    why: "Two tiers that are busy overlap often by accident. Rotating one tier in time against the other keeps the number, durations and order of its annotations but destroys the coupling — a surrogate test that annotation tools do not offer, so overlap counts are usually reported without a chance level.",
    steps: [
      "Co-occurrence: choose the two layers and how tiers go together (same participant, different participants).",
      "“Compared with unrelated timing” shows the observed overlap against the surrogate distribution for every pair of values.",
      "For inference across recordings, send the per-file association to Statistics and test the log ratio against zero.",
    ],
    view: "cooccurrence",
    refs: ["louwerse2012", "fusaroli2014"],
  },
  {
    title: "Who leads — in any modality?",
    why: "Leader–follower asymmetries are known for gaze and for syntactic repetition. The same diagonal-profile analysis works for any pair of categorical tiers (gesture types, head movements, floor states), but needs the tiers resampled and paired by hand in a scripting language.",
    steps: [
      "Recurrence: the same layer for both sides compares partners; two different layers compare modalities.",
      "The profile by lag shows whether recurrence peaks after a delay; “Tier pairs” lists the asymmetry of every pair.",
      "Send the pairs to Statistics: is the asymmetry reliably different from zero, and does it depend on role or condition?",
    ],
    view: "recurrence",
    refs: ["richardson2005", "dale2006", "coco2014"],
  },
  {
    title: "Do partners match in how bursty they are, beyond speech?",
    why: "Complexity matching was shown for the timing of speech. For gesture, gaze shifts or feedback it is an open question that only requires the same measures on other tiers — and a model that separates differences between dyads from differences within them.",
    steps: [
      "Temporal structure for the layer of interest: one row per tier with burstiness, memory and the Allan-factor slope.",
      "Send the table to Statistics › Multilevel model with file as the only grouping variable and no predictor.",
      "A large standard deviation between files relative to the residual means that partners resemble each other; compare with the model without the grouping variable.",
    ],
    view: "temporal",
    refs: ["abney2014", "abney2018"],
  },
  {
    title: "What comes next across modalities?",
    why: "Sequential analysis is usually run within one coding scheme. Pooling tiers into one stream of labelled events — gaze:partner, head:nod, a floor state — shows chains such as “speaker looks at partner → partner nods → speaker continues”, which no single tier contains.",
    steps: [
      "Sequences: tick several layers; choose one stream per recording so that both participants' events are interleaved, with the participant as part of the label.",
      "“What follows what” gives each transition with its credible interval and its ratio to the base rate; “Recurring sequences” the frequent chains.",
      "“How much history matters” compares Markov orders: does the next event depend on more than the current one?",
    ],
    view: "sequences",
    refs: ["bakeman2011", "strelioff2007"],
  },
  {
    title: "Is there evidence that nothing differs?",
    why: "Small multimodal corpora produce many non-significant comparisons that are then read as “no difference”. A Bayes factor separates evidence for the absence of an effect from a sample that is too small to tell — and can be monitored as recordings are added.",
    steps: [
      "Any table in Statistics › Two groups: the Bayes factor is reported in both directions; BF₀₁ above 3 is moderate evidence for no difference.",
      "The robustness plot shows whether the conclusion depends on the prior width; the sequential plot how the evidence grew row by row.",
      "For nested data use the multilevel model: the evidence for each term comes from comparing the models with and without it.",
    ],
    view: "statistics",
    refs: ["rouder2009", "vandoorn2021", "kass1995"],
  },
  {
    title: "Would the result survive a second annotator?",
    why: "Agreement is usually reported as one coefficient for a subset of the data and then set aside. When both raters' tiers are in the files, every downstream analysis can be run on each rater's version — the direct test of whether a conclusion depends on who annotated.",
    steps: [
      "Agreement: κ with its posterior, per category, and the list of disagreements with links to the timeline.",
      "Tiers & layers: give the second rater's tiers a layer of their own.",
      "Repeat the analysis with that layer and compare the estimates — in Statistics, both tables can be open side by side.",
    ],
    view: "agreement",
    refs: ["holle2015", "mathet2015"],
  },
];

// ---- how each view computes its numbers --------------------------------------------------------

export interface MethodDoc {
  view: ViewId;
  title: string;
  summary: string;
  points: string[];
  caveat?: string;
  refs: string[];
}

export const METHODS: MethodDoc[] = [
  {
    view: "corpus",
    title: "Corpus and file variables",
    summary: "Reads ELAN annotation files (.eaf, format 2.7 to 3.0) in the browser. Nothing is uploaded and the files are never changed.",
    points: [
      "Time slots without a time value are interpolated between their neighbours; reference annotations (symbolic association and subdivision) inherit the interval of their parent, subdivisions share it equally.",
      "The observation time of a recording is the end of its last annotation on any tier.",
      "File variables (condition, dyad, a score …) can be typed in, read from the file names with a pattern, or imported from a table; they travel with every result table.",
    ],
    refs: ["wittenburg2006"],
  },
  {
    view: "tiers",
    title: "Tiers, layers and participants",
    summary: "Tiers that hold the same kind of annotation for different participants form a layer; analyses address layers, so one setting covers a whole corpus.",
    points: [
      "Layer and participant are proposed from the tier names (A_gesture, gesture@B, Speech-Left …), from the PARTICIPANT attribute and from the linguistic type, and can be corrected by hand.",
      "Analyses that relate two layers pair tiers of the same participant, of different participants, or all tiers of a recording.",
      "A layer is treated as text, categories or numbers depending on its values; this only sets sensible defaults.",
    ],
    refs: [],
  },
  {
    view: "derive",
    title: "Derived tiers",
    summary: "New tiers computed from existing ones. They behave like any tier: they appear in the timeline and can be analysed, combined again and exported.",
    points: [
      "Overlap (AND), with / without (whole annotations that do or do not overlap another layer), merge (OR), pool (several layers on one tier with their values), gaps (NOT).",
      "Filter by value or duration, recode values with a pattern, join neighbours across short gaps, cut windows around starts or ends, split transcriptions into words with interpolated times.",
      "Turn-taking states (gap, pause, overlap) and alignment instances can be added as tiers, which makes them available to every other analysis.",
      "Recordings can be split at the annotations of a tier (rounds, phases, topics); each part becomes a recording with the label as a file variable.",
      "Export writes the derived tiers of each recording to a separate .eaf file to merge in ELAN; annotations that overlap on a derived tier are spread over several tiers.",
    ],
    refs: ["allen1983"],
  },
  {
    view: "timeline",
    title: "Timeline",
    summary: "All tiers of a recording on a shared time axis, with zoom, selection and value colours.",
    points: [
      "Overlays show the results of analyses in place: aligned words and expressions, the overlap of two layers, and the floor strip with gaps, pauses and overlaps. Each can be switched on and off.",
      "Tables in the analysis views open the timeline at the row that was clicked.",
    ],
    refs: [],
  },
  {
    view: "search",
    title: "Search",
    summary: "Finds annotations by text or regular expression, by duration, and by whether they overlap an annotation of another layer.",
    points: ["Results show the neighbouring annotations on the same tier, open in the timeline, and can be sent to Statistics as one row per annotation found."],
    refs: [],
  },
  {
    view: "descriptives",
    title: "Descriptives",
    summary: "How often, how long, how much of the time — per recording, participant and annotation value.",
    points: [
      "Count, total, mean, median and SD of the durations, latency of the first annotation, and the share of the recording that is covered.",
      "Rate per minute with a 95% credible interval from a Gamma posterior (Jeffreys prior on a Poisson rate).",
      "Group means are shown with credible intervals from a t distribution; one dot is one tier, so the spread between participants stays visible.",
    ],
    caveat: "Rates per minute divide by the whole recording. If only part of it was annotated, split the recordings at a tier that marks the annotated stretches.",
    refs: ["winter2021"],
  },
  {
    view: "alignment",
    title: "Lexical alignment",
    summary: "Speakers re-using expressions that their interlocutor produced earlier.",
    points: [
      "Text is split into words; case, punctuation and bracketed comments can be ignored, and function words (a list per language, the most frequent words, or your own list) never count as content.",
      "An alignment instance is a longest stretch of a turn — at least the chosen number of words, with at least one content word — that the other speaker produced earlier within the look-back window. The first production is the prime; a speaker's repetition of their own earlier words is counted separately as self-repetition.",
      "Per speaker: the share of tokens inside instances (expression repetition), the number of expressions adopted from and established for the partner, and the size and variety of the shared expression lexicon.",
      "Turn by turn: the share of a turn's content words that occur in the partner's previous turn (local alignment) and the cosine similarity of adjacent turns.",
      "Chance level: surrogate dialogues with each speaker's turns in shuffled order (keeps vocabulary, removes order) or with speakers of different recordings paired (keeps the task, removes the interaction). Observed minus surrogate is tested across recordings with a Bayesian t-test.",
    ],
    caveat: "Repetition is not yet alignment in the psychological sense: topic and task make people repeat words too. Report the measures against a chance level, and compare like with like — measures depend on the length of the dialogue.",
    refs: ["dubuisson2017", "dubuisson2021", "fusaroli2012", "duran2019", "healey2014", "xu2015"],
  },
  {
    view: "cooccurrence",
    title: "Co-occurrence",
    summary: "Which values of two layers overlap in time, how often, for how long, and how that compares with chance.",
    points: [
      "For every pair of values: the number of overlaps, the joint duration, and P(Y | X) — the share of X's time during which Y holds.",
      "Chance: with independent timing the expected joint duration is the product of the two durations divided by the observation time. The ratio of observed to expected (lift) and the log odds ratio of the 2 × 2 table of time are reported.",
      "Surrogates: the Y tier is rotated in time by a random amount, many times. This keeps the number, durations and order of its annotations but destroys the coupling with X, and gives a chance distribution without assuming independent moments.",
      "Temporal relations between overlapping annotations follow Allen's interval algebra (X starts before Y, X during Y, equal …), with a tolerance of one video frame by default.",
    ],
    caveat: "Overlap in time is symmetric and says nothing about direction; see Timing for which of the two starts first.",
    refs: ["allen1983", "louwerse2012", "kok2017"],
  },
  {
    view: "turntaking",
    title: "Turn-taking",
    summary: "Gaps, pauses and overlaps computed from the speech tiers.",
    points: [
      "Each speaker's annotations are joined into talkspurts across silences shorter than the minimum pause (180 ms by default).",
      "The recording is cut wherever the set of talking speakers changes. A silence between different speakers is a gap, within one speaker's talk a pause; overlap that ends in a change of speaker is a between-speaker overlap.",
      "The floor transfer offset is the duration of a gap, or minus the duration of a between-speaker overlap. Its distribution, median, and the shares of overlaps, gaps and near-zero transfers are reported per recording and speaker.",
    ],
    caveat: "Offsets inherit the precision of the annotation: with boundaries placed by hand, differences of a few tens of milliseconds are within annotation error.",
    refs: ["sacks1974", "heldner2010", "stivers2009", "levinson2015"],
  },
  {
    view: "timing",
    title: "Timing",
    summary: "When one kind of event happens relative to another.",
    points: [
      "Event lags: the time of a target event minus the time of a reference event, for all targets within a window (a cross-correlogram), or only the nearest or the next one. Start, end or middle of the annotations can be the anchor.",
      "Each bin is compared with the count expected if the targets were unrelated to the reference events, given their overall rate.",
      "For the nearest or next event, the mean lag is tested against zero with a Bayesian one-sample t-test.",
      "State around events: the probability that a value holds (gaze at the partner, say) at each moment before and after the reference events, compared with its overall share of the time.",
    ],
    caveat: "Lags of events from the same recording are not independent. For inference across recordings send the instances to Statistics and use recording as a grouping variable.",
    refs: ["kendon1967", "terbekke2024", "kok2017"],
  },
  {
    view: "sequences",
    title: "Sequences",
    summary: "The order of annotation values: what follows what.",
    points: [
      "Events of one or several layers form one sequence per tier, or one per recording with the participants' events interleaved by onset. Immediate repetitions can be collapsed and long silences can break a sequence.",
      "Transition probabilities get a Beta posterior (uniform prior over the next event): the credible interval, the ratio to the base rate of the target, and the probability that the transition is more likely than the base rate.",
      "Markov order: the marginal likelihood of the sequences under order 0, 1 and 2 with Dirichlet priors, scored on the same events. The posterior probability of each order says how much history matters.",
      "Recurring n-grams with their counts, and the probability of a target a given number of steps after a source.",
    ],
    refs: ["bakeman2011", "strelioff2007"],
  },
  {
    view: "recurrence",
    title: "Recurrence",
    summary: "Categorical cross-recurrence of two symbol sequences.",
    points: [
      "Sequences are either one symbol per annotation (or per word), or the tier sampled at a fixed time step.",
      "Two sequences recur at (i, j) when they show the same symbol. The share of recurrent points along each diagonal j − i = lag is the diagonal profile: a peak to the right of zero means Y repeats what X did a little earlier.",
      "Chance level: the recurrence rate expected from the frequencies of the symbols alone; the log ratio of observed to expected is reported per pair of tiers.",
      "Determinism (the share of recurrent points on diagonal lines), mean and longest line, line entropy, the lag of the peak and the leader–follower asymmetry (recurrence at positive minus negative lags).",
    ],
    caveat: "With few categories, recurrence is high by chance. Read the profile relative to the chance level, not its absolute height.",
    refs: ["dale2006", "coco2014", "richardson2005", "fusaroli2014"],
  },
  {
    view: "temporal",
    title: "Temporal structure",
    summary: "Whether events are spread evenly or come in bursts, and whether their rate changes.",
    points: [
      "Burstiness B = (σ − μ) / (σ + μ) of the intervals between event onsets: −1 for perfectly regular, 0 for random (Poisson), towards 1 for bursty; with the correction for short sequences. The memory coefficient is the correlation of consecutive intervals.",
      "Allan factor: the variance of the difference between the counts in adjacent windows, relative to the mean count, across window sizes. A power-law increase indicates clustering on all time scales; its exponent is reported.",
      "Change point: a Poisson rate that is constant, against one that switches once at an unknown time; the Bayes factor and the posterior of the switch time.",
      "Bayesian blocks: the most probable division of the recording into stretches of constant rate.",
    ],
    caveat: "All measures need enough events: below about 20 per tier they are reported but mean little.",
    refs: ["goh2008", "kim2016", "abney2014", "abney2018", "scargle2013"],
  },
  {
    view: "lexicon",
    title: "Lexicon",
    summary: "Word-level statistics of transcription layers.",
    points: [
      "Frequency list with relative frequency and dispersion (DP: 0 when a word is spread like the text sizes, towards 1 when it is concentrated in few speakers).",
      "Lexical diversity: type–token ratio and the indices of Guiraud and Herdan for reference, and the length-robust MATTR (mean ratio in a moving window) and MTLD, plus Yule's K and the share of words that occur once.",
      "Key words: the log odds ratio of a word between two groups with an informative Dirichlet prior (the pooled distribution), divided by its standard deviation. Rare words are shrunk towards “no difference”.",
      "Concordance: every occurrence of a word or pattern with its left and right context.",
    ],
    refs: ["gries2008", "covington2010", "mccarthy2010", "monroe2008"],
  },
  {
    view: "agreement",
    title: "Inter-annotator agreement",
    summary: "Agreement of two raters on time-aligned annotations.",
    points: [
      "Linking: an annotation of rater 1 and one of rater 2 are the same unit when their overlap covers at least the chosen share of the longer one. Each annotation is linked at most once; the rest are unlinked.",
      "Cohen's κ over all units, with “no annotation” as a category (segmentation and label together), and over linked units only (labels, given the same segmentation).",
      "Posterior of κ: the cell probabilities of the confusion matrix get a Dirichlet prior, and κ is computed for each posterior draw. Reported are the median, a 95% credible interval and the probability that κ exceeds 0.6 and 0.8.",
      "A time-based κ compares what the two raters coded at every moment; boundary differences of linked units show how precisely onsets and offsets agree.",
    ],
    caveat: "κ depends on how frequent the categories are; compare coefficients only between studies with similar category distributions, and always inspect the confusion matrix.",
    refs: ["cohen1960", "holle2015", "mathet2015"],
  },
];

// ---- the statistics lab ----------------------------------------------------------------------

export interface StatsTopic {
  title: string;
  paragraphs: string[];
  refs: string[];
}

export const STATISTICS: StatsTopic[] = [
  {
    title: "Why Bayesian, and why only Bayesian",
    paragraphs: [
      "Annotated corpora are small and expensive: a few recordings, a few dozen speakers. A Bayes factor says how much the data support one hypothesis over another, in either direction — so “no evidence for a difference” and “evidence for no difference” are different outcomes. The evidence can be looked at as recordings are added without invalidating the inference, and estimates come with intervals that mean what they seem to mean: the parameter lies in a 95% credible interval with probability 0.95, given the model and the prior.",
      "There are no p-values in this program. Mixing the two frameworks invites picking whichever looks better.",
    ],
    refs: ["kass1995", "vandoorn2021", "vasishth2018"],
  },
  {
    title: "Reading a Bayes factor",
    paragraphs: [
      "BF₁₀ = 8 means the data are eight times more likely under the alternative than under the null hypothesis; BF₁₀ = 0.125 means the same in the other direction (BF₀₁ = 8). The labels used here follow a common convention: 1–3 anecdotal, 3–10 moderate, 10–30 strong, 30–100 very strong, above 100 extreme. They are a reading aid, not thresholds.",
      "A Bayes factor compares two specific models, and the alternative includes its prior: a very wide prior predicts large effects and is penalised when the effect is small. Each test therefore shows how the result changes with the prior width. Report the prior with the result.",
    ],
    refs: ["jeffreys1961", "lee2013", "vandoorn2021"],
  },
  {
    title: "The tests and their priors",
    paragraphs: [
      "Two groups (t-test): independent, paired and one-sample designs. Under the alternative the standardised effect δ has a Cauchy prior (scale 0.707 by default); one-sided alternatives truncate it. Reported are the Bayes factor, the posterior of δ, a robustness curve over prior widths and the sequential course of the evidence.",
      "Several groups (ANOVA): the model with different group means against the model with equal means, with a multivariate Cauchy prior on the standardised effects; exact for groups of unequal size. Pairwise comparisons are default t-tests whose posterior odds are corrected for multiplicity.",
      "Correlation: Pearson's ρ with a stretched Beta prior on (−1, 1); width 1 is uniform. The posterior of ρ is exact.",
      "Contingency tables: independence against association with Dirichlet priors on the cell probabilities, for four sampling plans (nothing fixed, total fixed, row or column totals fixed). Cramér's V and, for 2 × 2 tables, the odds ratio with credible intervals.",
      "Counts and rates: a comparison of two Poisson rates with exposure (events per minute, per 100 words) and a normal prior on the log rate ratio; with more than two groups the counts are tested against the shares expected from the exposures. A binomial test of a proportion with a Beta prior, and a multinomial test of whether the categories of a variable are equally frequent.",
    ],
    refs: ["rouder2009", "gronau2020", "rouder2012", "westfall1997", "ly2018", "gunel1974", "jamil2017"],
  },
  {
    title: "Multilevel models",
    paragraphs: [
      "Annotations are nested: many gestures per speaker, two speakers per recording. Treating them as independent observations overstates the evidence. The multilevel model takes any outcome — Gaussian, log-normal for durations, robust Student-t, Poisson and negative binomial for counts (with exposure), Bernoulli and binomial — with fixed effects, one interaction, and a random intercept for every grouping variable.",
      "The posterior is sampled with the No-U-Turn sampler in several chains run in parallel. Priors are weakly informative and scaled to the data: a coefficient of a standardised predictor ~ Normal(0, 2.5 SD of the outcome), or Normal(0, 2.5) on the link scale for counts and proportions; standard deviations ~ Exponential. The width can be changed.",
      "For each coefficient: posterior mean and 95% credible interval, the probability of direction, and the share of the posterior inside a region of practical equivalence around zero. The evidence for each term is the Bayes factor of the fitted model against the same model without that term, both marginal likelihoods estimated by bridge sampling. Predictors inside an interaction are not tested on their own.",
      "A Bayes factor for a single coefficient from the density ratio at zero (Savage–Dickey) is given only when zero lies within the posterior draws. It is never extrapolated from a normal approximation: in multilevel models a group-level variance can absorb an effect, the posterior has heavy tails, and the extrapolation can overstate the evidence by orders of magnitude.",
      "Models fitted to the same rows are compared by their marginal likelihoods and by WAIC, an estimate of out-of-sample predictive accuracy.",
    ],
    refs: ["hoffman2014", "gelman2008", "gronau2017", "meng1996", "wagenmakers2010", "dickey1971", "kruschke2018", "makowski2019", "watanabe2010", "vehtari2017", "barr2013", "winter2021"],
  },
  {
    title: "Checks before believing a model",
    paragraphs: [
      "Convergence: R̂ at most 1.01 for every parameter (rank-normalised, split chains), effective sample sizes of at least 400, no divergent transitions. The model card shows all three and says what to change when one fails.",
      "Fit: the posterior predictive check overlays the observed outcome with data simulated from the fitted model. If the simulated distributions do not look like the data, change the kind of outcome before interpreting coefficients.",
      "Unit of analysis: the simple tests assume independent rows, and say so when the rows of a table come from few recordings. Many annotations from twelve recordings are not many observations: aggregate to one row per speaker or recording first (Data › Aggregate), or use the multilevel model.",
      "Small number of groups: with a handful of recordings the between-recording variation is poorly determined and the prior matters. Report it, and prefer wide intervals to confident claims.",
    ],
    refs: ["vehtari2021", "vandoorn2021", "barr2013"],
  },
  {
    title: "How the numbers were checked",
    paragraphs: [
      "The statistical core is written for this program and tested against independent implementations: special functions and distributions against SciPy and mpmath at high precision; t-test, ANOVA, correlation and contingency-table Bayes factors against the R package BayesFactor; multilevel models against Stan through rstanarm (posterior means and standard deviations); bridge sampling against marginal likelihoods obtained by exact integration, for a multilevel model as well.",
      "The scripts that produced the reference values and the tests that compare against them are part of the source code (tests/reference, tests/fixtures).",
    ],
    refs: ["gronau2017"],
  },
];

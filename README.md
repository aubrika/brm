# Bit-Rate Maximizer

The bit-rate maximizer is a game with an uncommon purpose: actively helping the player get the highest score possible on their very first scored playthrough. 

To play the game, the player simply uses a mouse (for best results) or other pointing device to click the orange grid cells as quickly and accurately as they can for 60 seconds. The position of the next orange cell is highlighted with a "ghost target" providing a degree of look-ahead, so that the player can infer where the mouse must move next. The player's score is identical to their bit rate, representing how fast the player transfers information through the game interface. 

Bit rate is calculated as follows:

```math
B \;=\; \frac{\log_2\!\left(\textcolor{#5a8ad0}{N} - 1\right)\,\cdot\,\max\!\left(\textcolor{#b77e00}{S_c} - \textcolor{#eb5460}{S_i},\; 0\right)}{\textcolor{#838899}{t}}
```


| term | meaning | in the game |
|---|---|---|
| $\textcolor{#5a8ad0}{N}$ | number of possible selections | the number of grid cells on the target grid |
| $\textcolor{#b77e00}{S_c}$ | correct selections in time window $\textcolor{#838899}{t}$  | correct clicks of the target cell |
| $\textcolor{#eb5460}{S_i}$ | incorrect selections in $\textcolor{#838899}{t}$ | clicks that miss the target cell |
| $\textcolor{#838899}{t}$ | time in seconds | one 60-second evaluation window |

The target sequences (in this case, sequences of various grid states) comprising the set of possible selections must be `"sampled uniformly at random with replacement from an alphabet of size N ≥ 3. The sequence must be i.i.d. — no patterns, no structure, no language models, no predictive text, no word-level targets"`. This means the sequences are devoid of internal structure which could allow a player to start predicting them, making this something of a "noise transcription" task, and essentially less efficient than the transcription of natural language or other patterns. The randomness of the generated sequences may be confirmed in `sequence.ts`. The "alphabet" in the game is the set of (x,y) tuples where x,y >= 0 and x,y < G, where G is grid size, providing an $\textcolor{#5a8ad0}{N}$ of G^2 elements.

## How to Play

Go to aubrika.github.io/brm and follow the instructions.

## Design Goals 

1. Minimize training requirement: the game should require minimal familiarization and use common interface devices
2. Maximize decision density: $\textcolor{#5a8ad0}{N}$ should be as large as is possible without increasing decision latency to the point of bit rate reduction
3. Use UI features to reduce decision latency: where possible, the UI should assist the user in making the correct decision (as with the "ghost targets") without altering the IID property of the grid sequences
4. Provide accessible UI (use colorblind-friendly palettes, enable alternate keyboard layouts, enable low vision modes or screen readers, etc)

## Development Process

### *Version 0: Character Sequences (Typing Random Letters Slowly: The Game)*

An initial prototype was created to verify the bit-rate calculation of a player typing a single randomized sequence of home-row keys (asdfjkl;), displayed one at a time, on a QWERTY keyboard, yielding bit rates of 1-2 bit/s.

### *Version 1: Falling Lanes (The World's Least-Fun Rhythm Game)*

A brief review of the research on typing speed indicated that providing several characters at once could provide much higher reaction times for transcription, so several improvements were attempted. Displaying several letters at once yielded a bit rate of around 3 bit/s for IID data against the same home row alphabet of N=8. The introduction of a "piano roll" of vertically arranged letters, scrolling right to left, yielded an additional 1bit/s. The rotation of the piano roll 90 degrees, so that each "lane" sat directly above its associated finger, with the letters connected by a line traced along their sequence also yielded about 1bit/s thanks to a reduced reaction time. The introduction of the Okabe-Ito color palette seemed to reduce error rate of adjacent fingers by a marginal amount (but looked nice, I thought). The introduction of audio cues such as character-specific tones played to indicate the current target character, or a "pacer" to encourage faster input, seemed to have very little effect. This first "falling lane" version of the game, played with an $\textcolor{#5a8ad0}{N}$ of 4 to 16 seemed to hit a functional ceiling on performance at around 5 or 6 bit/s, with a couple outlier runs at 7 bit/s. A brief survery of research quickly indicated this was well below the commonly-attested bit rate of 10bit/s for human neural processing, so I decided to stop attempting incremental improvements to this version and move laterally.

You can still play V1 at aubrika.github.io/brm/v1.

### *Version 2: Cell Selection (The World's Most Exciting Orange Square Blasting Game)*

The bit rate calculation provides two primary levers for improvement: increasing $\textcolor{#5a8ad0}{N}$ or increasing $\textcolor{#b77e00}{S_c}$ / $\textcolor{#838899}{t}$ without increasing $\textcolor{#eb5460}{S_i}$. It seemed my options for hitting the ceiling of physiological ability were then either to vastly increase the number of possible selections, or vastly increase the rate at which correct selections were made. Since V1 had largely focused on the latter by attempting to improve the player's transcription speed of random character sequences, I decided to try increasing $\textcolor{#5a8ad0}{N}$.

First, I asked a simple question: if I were to make (only) a correct decision every second, what set cardinality or $\textcolor{#5a8ad0}{N}$ would provide a bit rate of 10 bit/s? 1025. Where could I get an "alphabet" of size 1025 that everyone already knows and can hold in their head? I realized that if I switched the input to a pointing device (e.g. a mouse or trackpad), I could divide part of the player's visual field (e.g. a computer screen) into a grid, and a grid divided into 32 units on a side would have 1024 cells in it. Each cell would be a "letter" of the "alphabet" of the game, out of which the player is selecting a single option with every click. I also realized immediately that a naive implementation would lack any kind of look-ahead provision, so I implemented the "ghost" target to indicate the direction of the upcoming click and hopefully thereby reduce decision latency. My very first run of the V2 implementation against a 32x32 grid yielded a bit rate of 12bit/s, exceeding my expectations. 

Various other improvements and experiments were attempted, including additional look-ahead targets (marginal or null improvement) and a "magnification" function to ostensibly allow for even larger $\textcolor{#5a8ad0}{N}$, but the additional time required for target acquisition nullified any advantage of the greater number of possible selections provided by a 128 x 128 grid, for example. Using a mouse, with a single highlighted target, and a single next target indicator, I am able to reliably hit bit rates of 12-13 bit/s, which exceeds the ceiling suggested by research of about 10 bit/s. Using a trackpad, however, my bit rate on the task never exceeded 10 bit/s, strongly recommending a mouse for optimal play.

## Relevant Research

I wasn't able to find any detailed research on, for example, typing speeds for IID data, other than a few references to it being "slower". This particular kind of evaluation setup seems relatively under-explored in the literature.

I was able to find and read W.E. Hicks' *On the rate of gain of information* (1952), which indicated a bit rate ceiling of about 5 bit/s for a task roughly comparable to the one presented by my V1 implementation (using Morse paddles instead of a computer keyboard). This supports the plausibility of a 5-6 bit/s ceiling I hit, and also supports the decision to try a different implementation for higher bit rates.

I credit Zheng & Meister's *The unbearable slowness of being: Why do we live at 10 bits/s?* for inspiring me to explicitly target a 10bit/s bit rate, and thereby giving me the idea for the entire cell selection implementation.

## Potential Applications & Future Development

If the effect size of the look-ahead "ghost" target can be reproduced and confirmed to be significant, a pointing task like this could be used to confirm BCI functionality in an animal subject incapable of self-report but capable of similar pointing tasks, such as a primate. The effect of the look-ahead targets may be sufficiently significant that providing a stimulus corresponding to the visual region of the upcoming target via a BCI implant could indicate and help quantify BCI functionality versus a control performing the same task without look-ahead cues.
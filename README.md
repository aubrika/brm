# Bit-Rate Maximizer

The bit-rate maximizer is a game with an uncommon purpose: actively helping the player get the highest score possible on their very first scored playthrough.

The player's score is their `bit rate`, representing how fast the player transfers information through the game interface. 

`Bit rate` is calculated as follows:

```math
B \;=\; \frac{\log_2\!\left(\textcolor{#5a8ad0}{N} - 1\right)\,\cdot\,\max\!\left(\textcolor{#b77e00}{S_c} - \textcolor{#eb5460}{S_i},\; 0\right)}{\textcolor{#838899}{t}}
```

| term | meaning | in the game |
|---|---|---|
| $\textcolor{#5a8ad0}{N}$ | number of possible selections | the number of grid cells on the target grid |
| $\textcolor{#b77e00}{S_c}$ | correct selections in time window $\textcolor{#838899}{t}$  | correct clicks of the target cell |
| $\textcolor{#eb5460}{S_i}$ | incorrect selections in $\textcolor{#838899}{t}$ | clicks that miss the target cell |
| $\textcolor{#838899}{t}$ | time in seconds | one 60-second evaluation window |
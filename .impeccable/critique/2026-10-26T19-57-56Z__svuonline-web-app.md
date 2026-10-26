---
target: "https://svuonline.web.app/"
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "url:https://svuonline.web.app/"
timestamp: 2026-10-26T19-57-56Z
slug: svuonline-web-app
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|:-----:|-----------|
| 1 | Visibility of System Status | 3 | Solid demuxer & batch progress indicators, but lacks server proxy live status on static hosting |
| 2 | Match System / Real World | 3 | Authentic SVU academic terminology; broken by developer CLI commands in About modal |
| 3 | User Control and Freedom | 3 | Strong home escape routes & keyboard shortcuts; hampered by unskippable tour reload pop-up |
| 4 | Consistency and Standards | 2 | Mobile 'Help' button opens About instead of Guide; redundant feature lists across 3 views |
| 5 | Error Prevention | 3 | Locked cascade prevents invalid batching; lacks instant URL validation on direct link paste |
| 6 | Recognition Rather Than Recall | 3 | Rapid course directory search; but mobile player controls hide button labels entirely |
| 7 | Flexibility and Efficiency | 4 | Outstanding: Keyboard accelerators, double-tap seek, chat timestamp jumps, vocal DSP |
| 8 | Aesthetic and Minimalist Design | 2 | 14 player controls un-chunked in one row; About & Guide modals suffer from visual noise |
| 9 | Error Recovery | 3 | Clear Arabic playback errors; lacks proxy guidance when offline |
| 10 | Help and Documentation | 2 | Comprehensive content; undermined by aggressive auto-popup on every reload & dual format redundancy |
| **Total** | | **28/40** | **Good (70%)** |

## Design Specificity Verdict
Grounded core for Syrian Virtual University students with localized RTL IBM Plex Sans Arabic and offline-first survival tools, marred by repetitive modal boilerplate, developer terminal jargon in user-facing dialogs, and cyan glow halos.

## Priority Issues
- [P1] Pocket Guide (#welcome) Dual Redundancy & Aggressive Auto-Popup
- [P1] Circular Navigation & Developer Jargon in About Modal (#about)
- [P2] Desktop Player Control Bar Overcrowding (14 Items in One Row)
- [P2] Cryptic Icon-Only Buttons on Mobile Portrait Player Bar
- [P2] Undersized Typography (<11px) & WCAG AA Contrast Failures

# Six-paper review — 2026-07-09

Six sources Euan asked about, checked against the project's needs: real numeric bathymetric data
(especially 15-25 m+, the SDB "optical wall"), submarine canyon coordinates/depths, and reef
locations for Sodwana Bay. Read via subagents (2 UKZN ResearchSpace bitstream fetches + 2 local
PDFs from Downloads, pdftotext-extracted and read in full; 1 ScienceDirect abstract page, full text
paywalled). None contain a downloadable grid/CSV — all are narrative theses/papers with figures as
images, consistent with their era (1991-2013, pre-open-data norms). But two of them name the exact
people and organisation who physically hold real multibeam data over the Sodwana canyons — that's
the real find here.

## 1. Ramsay, P.J. (1994) "Marine geology of the Sodwana Bay shelf, southeast Africa" — *Marine Geology* 120(3-4):225-247
sciencedirect.com/science/article/abs/pii/0025322794900604, DOI 10.1016/0025-3227(94)90060-4

- **Paywalled** — only the abstract is accessible (Elsevier, no institutional access from this
  session). Abstract confirms: narrow 3 km shelf, submarine canyons, coral reefs on beachrock/
  aeolianite from −5 to −95 m (Late Pleistocene palaeocoastlines), subaqueous dune fields at
  −35 to −70 m migrating south (Agulhas Current driven). States **"three"** submarine canyons in
  the study area — the companion 1991 PhD thesis below (same author, same shelf) surveyed **four**
  (Jesser, Wright, Beacon, White Sands). Not a contradiction we can resolve without the full text;
  flagging honestly rather than picking one number.
- **Verdict: reference only.** This is almost certainly the published, condensed version of
  Ramsay's 1991 PhD thesis (below) — the thesis gives more numeric detail than this abstract does.
  Not worth pursuing full-text access unless the thesis turns out to be missing something specific.

## 2. Ramsay, P.J. (1991) PhD thesis — *"Sedimentology, Coral Reef Zonation, and Late Pleistocene Coastline Models of the Sodwana Bay Continental Shelf, Northern Zululand"*, University of Natal, Durban
researchspace.ukzn.ac.za, bitstream 8ed9afbb

- **Directly covers the Sodwana Bay core of the AOI** — 59 km² survey from 3 km south of Jesser
  Point to Gobey's Point (essentially Jesser Point/Two-Mile Reef).
- **Real canyon table (figure, not machine-readable text) with genuine numbers:**
  - Jesser Canyon: head −70 m, gradient 10.1°, axis 100°, youthful-phase
  - **Wright Canyon**: head −38 m, breaches shelf 2 km offshore, traced to **−453 m**, gradient
    20.6°, max width 1.2 km, mature-phase (largest surveyed)
  - Beacon Canyon: head −70 m, traced to −97 m, gradient 3°, youthful-phase
  - **White Sands Canyon**: head near shelf break −65 m, steepest head gradient 41.4°, traced to
    **−353 m**, mature-phase
  - Shelf break at −65 m, 2.1-4.1 km offshore, average gradient 1-2.5°
- Underlying survey: 2,154 echo-sounder points over 226 km of lines (SIMRAD EK120 + ELAC digital
  echosounder), gridded in 1991-era Surfer software into a 1:15,000, 5 m-contour paper map ("Map 1")
  plus a side-scan sedimentology map ("Map 2") — both physical plate inserts, not digital data, and
  1991 GPS accuracy was poor (~48 m mean error).
- Reef zonation model built on Two-Mile Reef, extended to Four-Mile, Seven-Mile, and **Red Sands
  Reef** (all named in the project's AOI).
- Text extraction cut off mid-document (page ~52 of ~202) — Appendix/Maps 1 & 2 (the actual data)
  were not reached, so a data-appendix sounding table can't be ruled in or out from this pass.
- **Verdict: genuinely useful for canyon labels/validation** (real depth/gradient/orientation
  numbers beyond the CGS isobaths' −95 m cutoff), **not for fusion input as-is** — no digitizable
  grid, and 1991 GPS accuracy is far coarser than the project's current data. Worth a short email to
  Ramsay (see #6 below — he's traceable, still active) or UKZN Geology asking if Map 1's digitized
  soundings survive, but don't expect much given the pre-GIS era.

## 3. Salzmann, L. (2013) MSc thesis — *"Submerged Shoreline Sequences on the KwaZulu-Natal Shelf"*, UKZN, supervised by Dr Andrew Green & Prof J.A.G. Cooper
researchspace.ukzn.ac.za, bitstream 16b74116

- Two survey blocks: central KZN (Durban/Umdloti, outside AOI) and **northern KZN, "between Lake
  St Lucia and the Kosi Lake system"** — includes Sodwana. Names **"the five shelf-indenting
  canyons... from north to south: Mabibi, Sodwana, Diepgat, Leadsman and Leven Canyons."**
- Barrier shoreline/shoal features (citing Ramsay 1994) occur at **15-25 m, 13-45 m, 50-60 m, and
  70-95 m** — a genuine, citable depth-band framework for what should exist in exactly the project's
  weak 15-25 m band.
- Northern KZN shelf: 2-4 km wide, ~2.7° average gradient, shelf break at −100 m. Feature depths by
  location (image captions, not text tables): Leven Point barrier at −100 m + planation surfaces at
  −70/−65/−60 m; Diepgat distinct −100 m and −60 m barriers; Leadsman both −60 m and −100 m.
- No extractable numeric data in the portion read (1,300/1,300 lines — the extraction itself was
  truncated mid-Chapter 2 by the source fetch; Chapter 3 body text and Appendices I-III, which per
  the table of contents hold the actual depth/width tables, were not reached).
- **Verdict: real lead, not just background** — confirms Dr Andrew Green's UKZN group holds
  multibeam data over exactly the Sodwana/Mabibi/Diepgat/Leadsman/Leven canyon band. See #6 below.

## 4. Miller, W.R. (1998) MSc dissertation — *"The Bathymetry, Sedimentology and Seismic Stratigraphy of Lake Sibaya - Northern KwaZulu-Natal"*, University of Natal (Durban)
local file, Downloads/Miller_Warwick_Richard_1998.pdf (154 pp, read in full)

- **Out of scope — drop as a primary source.** Lake Sibaya (27°15'-27°25'S, 32°33'-32°43'E) is an
  inland freshwater lake behind the coastal dune cordon, entirely separate from the Sodwana Bay
  ocean AOI. Only real numeric table is 7 radiocarbon dates (Appendix 7); everything else is
  figures/prose.
- **Useful only as a citation trail**: its regional sea-level/dune chronology (LGM ≈−130 m at
  ~18 ka; Eemian highstand +4-5 m at ~120 ka; Holocene recovery by ~7 ka) is drawn from — and
  explicitly points back to — **Ramsay's 1991 PhD thesis and 1996/1997 papers**, i.e. source #2
  above. Doesn't add anything the project doesn't already have via Ramsay directly.

## 5. Green, A.N. (2009) PhD thesis — *"The Marine Geology of the Northern KwaZulu-Natal Continental Shelf, South Africa"*, UKZN Westville
local file, Downloads/Green_Andrew_Noel_2009.pdf (277 pp, read in full) — **the most important document of the six**

- **Directly covers the AOI.** Study area Leven Point to Island Rock (~100 km of coast). Named
  canyons verbatim: **Jesser, Wright, Diepgat, Chaka, Leadsman, Leven, Mabibi (North/South), White
  Sands, Island Rock, South Island Rock.** ("Beacon" canyon from Ramsay 1991 is not named here —
  possibly a different classification scheme, not a contradiction.)
- **Real, dedicated field surveys — this is why it matters:**
  - Multibeam: **Reson Seabat 8111 ER**, 150° swath, 392 km² covered, **29-838 m depth, ~1 m
    resolution** — this is genuinely the kind of data the project needs for the 15-25 m+ gap.
  - Boomer seismic: 500 J, 400 line-km over 478 km², DGPS sub-metre positioning.
  - Side-scan sonar: Klein 2000/3000, mosaics in ArcGIS 9 ("data courtesy of the Council for
    Geoscience").
  - Field dates April 2004-March 2008; funded by NRF Innovation Fund (grant #24401), ACEP/DST/DEAT.
- Numeric fragments found (figure captions/text, not tables): shelf break ~100 m (stated as
  "~120 m" elsewhere in the same thesis — an internal inconsistency, reported honestly rather than
  picked); shelf gradients 4° (Leven/Sodwana), 5° (Leadsman/Diepgat), 7° (Mabibi); submerged
  sea-level-indicator caves at **~106 m, 125 m, 130 m** across six canyons (42 caves total); a
  cobble conglomerate at 124 m in South Island Rock Canyon. Landslide headscarp heights: Wright
  50.9±7.3 m, Diepgat 35±3.8 m, Leadsman 19.6±1.7 m, Mabibi 17.6±2.7 m. The −453 m Wright /
  −353 m White Sands figures from Ramsay (1991) were **not** independently corroborated in this
  thesis's text.
- **No extractable data tables** — bathymetry maps are UTM-36S figures (images), Appendices 1-2 are
  literally described as "A0 fold out" printed plates.
- **The data-availability statement (Appendix 4) is the key finding**, quoted directly: *"Raw
  seismic data in the form of SEG-Y data has not been included digitally for fears of misuse by
  others... These data are earmarked for publication at a later date."* The thesis itself confirms
  real digital grids exist but were deliberately withheld in 2009.
- **Concrete contacts named in the thesis itself:**
  - **Peter Ramsay, Marine GeoSolutions (Pty) Ltd, 106 Clark Road, Glenwood, Durban, 4001** —
    the private firm that physically collected the multibeam data. (Likely the same P.J. Ramsay as
    sources #1/#2 — now running a commercial marine geoscience firm.)
  - **Dr Andrew Green, greena1@ukzn.ac.za**, Joint Council for Geoscience-UKZN Marine Geoscience
    Unit, School of Geological Sciences, UKZN, Durban 4041 — the PI, corresponding author.
  - **Council for Geoscience — Marine Geoscience Unit**, Private Bag X112, Pretoria (co-funded the
    side-scan survey; contacts named in the thesis: Rio Leuci, Charl Bosman, Paul Young, Wade
    Kidwell).

## 6. What to actually do with this (needs Euan, non-blocking, ranked)

1. **Email Peter Ramsay at Marine GeoSolutions (Pty) Ltd** (106 Clark Road, Glenwood, Durban 4001)
   — this private firm physically holds the 392 km², 1 m-resolution Reson 8111 multibeam grid
   covering Leven Point→Island Rock, i.e. essentially the whole AOI's offshore canyon system. As a
   commercial operator they may license/share processed grids more readily than an academic archive.
2. **Email Dr Andrew Green (greena1@ukzn.ac.za)** — ask directly whether the SEG-Y/multibeam data
   withheld per his 2009 thesis Appendix 4 has since been "published at a later date" as the thesis
   promised, and whether a digital grid is now shareable.
3. **Council for Geoscience — Marine Geoscience Unit** (Private Bag X112, Pretoria) — co-funded the
   side-scan survey and is a statutory body that may hold an archived copy independent of the
   individual researchers. This is the same CGS the project already has a working relationship with
   (the 2005 Maputaland survey already integrated) — worth folding into that existing contact rather
   than starting cold.
4. Lower priority: request Ramsay's 1991 thesis Map 1/Map 2 (digitized soundings, if they survive)
   from UKZN Geology, and the Salzmann (2013) thesis's missing Chapter 3/Appendices I-III (may hold
   real depth/width tables for the five northern canyons — worth a second, complete fetch attempt).

None of this changes the project's current honest numbers (0-15 m RMSE 1.35 m PASS, 15-25 m RMSE
4.90 m FAIL) — it's a set of real, traceable leads toward the kind of ground-truthed multibeam data
that could actually close that gap, not data in hand yet.

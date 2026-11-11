# Texture credits and licences

Every file in this directory comes from a public-domain or CC BY 4.0 source. Nothing was taken from
the Space Engine game or from texture sites with unclear licences.

- **Public domain** = work of a U.S. government agency (NASA, USGS, NOAA) or NASA-funded mission
  imagery released under NASA's media usage guidelines. Credit is requested, not legally required;
  NASA material must not be used to imply NASA endorsement.
- **CC BY 4.0** = <https://creativecommons.org/licenses/by/4.0/>. The credit line given below must be
  shown clearly and visibly wherever the image is used (e.g. an in-app "Credits" screen), and
  modifications must be indicated. The "Changes" column records what was modified here.

All files were converted by the scripts in `scripts/textures/` (resize, re-encode; other changes as noted).

## Planets and moons

| File | Source | Author / agency (credit line) | Licence | Changes |
|---|---|---|---|---|
| `earth_color.jpg` | `8k_earth_daymap.jpg`, <https://www.solarsystemscope.com/textures/> (derived from NASA Blue Marble) | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | none (file copied) |
| `earth_clouds.jpg` | `8k_earth_clouds.jpg`, <https://www.solarsystemscope.com/textures/> | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | converted to greyscale, re-encoded |
| `earth_night.jpg` | Black Marble 2016, `BlackMarble_2016_3km.jpg`, <https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg> (NASA Earth Observatory, "Earth at Night" image record 144898) | NASA Earth Observatory / NASA's Goddard Space Flight Center (Suomi NPP VIIRS) | Public domain | downsized 13500x6750 -> 4096x2048 |
| `earth_height.png` | ETOPO 2022 60 arc-second global relief model (ice surface), fetched from NOAA ERDDAP <https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ETOPO_2022_v1_60s.html> | NOAA National Centers for Environmental Information, ETOPO 2022 Global Relief Model | Public domain (NOAA; "may be used and redistributed for free") | area-averaged 21600x10800 -> 4096x2048, longitude rolled to -180..180, 16-bit packed into R,G |
| `moon_color.jpg` | CGI Moon Kit, `lroc_color_poles_8k.tif`, <https://svs.gsfc.nasa.gov/4720> | NASA's Scientific Visualization Studio (Ernie Wright); Lunar Reconnaissance Orbiter Camera team | Public domain | re-encoded as JPEG |
| `moon_height.png` | CGI Moon Kit, `ldem_16.tif` (LOLA displacement map, 16 px/deg, float km), <https://svs.gsfc.nasa.gov/4720> | NASA's Scientific Visualization Studio (Ernie Wright); LRO Lunar Orbiter Laser Altimeter team | Public domain | area-averaged 5760x2880 -> 4096x2048, km -> m, 16-bit packed into R,G |
| `mars_color.jpg` | `8k_mars.jpg`, <https://www.solarsystemscope.com/textures/> (derived from NASA Viking/MGS data) | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | none (file copied) |
| `mars_height.png` | MGS MOLA Mission Experiment Gridded Data Record, `megt90n000eb.img` (topography, 16 px/deg, 16-bit), <https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/> | NASA / JPL / GSFC MOLA Science Team (Smith et al.), NASA Planetary Data System Geosciences Node | Public domain | area-averaged 5760x2880 -> 4096x2048, rolled from 0..360 to -180..180, 16-bit packed into R,G |
| `mercury_color.jpg` | `8k_mercury.jpg`, <https://www.solarsystemscope.com/textures/> (derived from NASA MESSENGER data) | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | downsized to 4096x2048 |
| `venus_color.jpg` | `4k_venus_atmosphere.jpg`, <https://www.solarsystemscope.com/textures/> | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | none (file copied) |
| `venus_surface.jpg` | `8k_venus_surface.jpg`, <https://www.solarsystemscope.com/textures/> (derived from NASA Magellan radar data) | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | downsized to 4096x2048 |
| `jupiter_color.jpg` | `8k_jupiter.jpg` (4096x2048), <https://www.solarsystemscope.com/textures/> | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | none (file copied) |
| `saturn_color.jpg` | `8k_saturn.jpg` (4096x2048), <https://www.solarsystemscope.com/textures/> | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | none (file copied) |
| `saturn_ring.png` | `8k_saturn_ring_alpha.png`, <https://www.solarsystemscope.com/textures/> | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | downsized 8192x500 -> 4096x250 (alpha-correct) |
| `uranus_color.jpg` | `2k_uranus.jpg`, <https://www.solarsystemscope.com/textures/> | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | none (file copied) |
| `neptune_color.jpg` | `2k_neptune.jpg`, <https://www.solarsystemscope.com/textures/> | Solar System Scope (solarsystemscope.com) | CC BY 4.0 | none (file copied) |
| `io_color.jpg` | Io Galileo SSI / Voyager Color Merged Global Mosaic 1 km, <https://planetarymaps.usgs.gov/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif> | NASA / JPL / USGS Astrogeology Science Center | Public domain | downsized to 4096x2048 |
| `europa_color.jpg` | Europa Voyager - Galileo SSI Global Mosaic 500 m (greyscale), <https://planetarymaps.usgs.gov/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif> | NASA / JPL / USGS Astrogeology Science Center | Public domain | downsized, rolled to 0 deg centre, small unimaged polar gaps (4.5%) smoothly filled |
| `ganymede_color.jpg` | Ganymede Voyager - Galileo SSI Global Color Mosaic 1.4 km, <https://planetarymaps.usgs.gov/mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif> | NASA / JPL / USGS Astrogeology Science Center | Public domain | downsized, rolled to 0 deg centre, small gaps (3.8%) smoothly filled |
| `callisto_color.jpg` | Callisto Voyager - Galileo SSI Global Mosaic 1 km (greyscale), <https://planetarymaps.usgs.gov/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif> | NASA / JPL / USGS Astrogeology Science Center | Public domain | downsized, rolled to 0 deg centre, small gaps (4.2%) smoothly filled |
| `titan_color.jpg` | Titan Cassini ISS Global Mosaic 4 km (PIA19658, 938 nm, greyscale), <https://planetarymaps.usgs.gov/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif> | NASA / JPL-Caltech / Space Science Institute / USGS | Public domain | downsized 4040x2020 -> 2048x1024, rolled to 0 deg centre |
| `enceladus_color.jpg` | Enceladus Cassini ISS Global Mosaic 100 m (high-pass filtered, greyscale), <https://planetarymaps.usgs.gov/mosaic/Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif> | NASA / JPL-Caltech / Space Science Institute / USGS | Public domain | downsized, rolled to 0 deg centre, gaps (6%) filled, brightness raised / contrast reduced |
| `triton_color.jpg` | Triton Voyager 2 Color Mosaic 600 m, <https://planetarymaps.usgs.gov/mosaic/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif> | NASA / JPL / USGS Astrogeology Science Center | Public domain | downsized to 2048x1024; the unimaged 39% of the globe is a synthetic smooth fill |
| `pluto_color.jpg` | "Pluto Color Map" PIA11707, <https://images.nasa.gov/details/PIA11707> | NASA / Johns Hopkins University Applied Physics Laboratory / Southwest Research Institute | Public domain | downsized, rolled to 0 deg centre; the unimaged 31% of the globe is a synthetic smooth fill |

Solar System Scope states that its textures are "based on NASA elevation and imagery data" with
"gaps filled with fictional terrain"; the gas/ice-giant maps and the Venus atmosphere map are
artist-processed composites rather than direct mission mosaics.

## Sky

| File | Source | Author / agency (credit line) | Licence | Changes |
|---|---|---|---|---|
| `sky_milkyway.jpg` | Deep Star Maps 2020, `milkyway_2020_8k_gal.exr`, <https://svs.gsfc.nasa.gov/4851> | NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. Constellation figures based on those developed for the IAU by Alan MacRobert of Sky and Telescope magazine (Roger Sinnott and Rick Fienberg). | Public domain | tone-mapped from linear float EXR to 8-bit sRGB JPEG |
| `sky_stars.jpg` | Deep Star Maps 2020, `starmap_2020_8k_gal.exr`, <https://svs.gsfc.nasa.gov/4851> | same as above (Hipparcos-2, Tycho-2 and Gaia DR2 catalogues) | Public domain | tone-mapped from linear float EXR to 8-bit sRGB JPEG |

## Galaxies (`galaxies/`)

All galaxy sprites were cropped to a square, resized to 1024x1024, sky-background-subtracted and
faded to black towards the edges (so they can be drawn additively). Under CC BY 4.0 these are
modified versions of the originals; the credit lines below are the unaltered ones from the source pages.

| File | Object | Source page | Credit line | Licence |
|---|---|---|---|---|
| `galaxies/m51.jpg` | M51 Whirlpool Galaxy | <https://esahubble.org/images/heic0506a/> | NASA, ESA, S. Beckwith (STScI), and The Hubble Heritage Team (STScI/AURA) | CC BY 4.0 |
| `galaxies/m74.jpg` | M74 | <https://esahubble.org/images/heic0719a/> | NASA, ESA, and The Hubble Heritage (STScI/AURA)-ESA/Hubble Collaboration | CC BY 4.0 |
| `galaxies/m81.jpg` | M81 | <https://esahubble.org/images/heic0710a/> | NASA, ESA and the Hubble Heritage Team (STScI/AURA). Acknowledgment: A. Zezas and J. Huchra (Harvard-Smithsonian Center for Astrophysics) | CC BY 4.0 |
| `galaxies/ngc1300.jpg` | NGC 1300 | <https://esahubble.org/images/opo0501a/> | NASA, ESA, and The Hubble Heritage Team (STScI/AURA) | CC BY 4.0 |
| `galaxies/ngc4414.jpg` | NGC 4414 | <https://esahubble.org/images/opo9925a/> | Hubble Heritage Team (AURA/STScI/NASA/ESA) | CC BY 4.0 |
| `galaxies/m104.jpg` | M104 Sombrero Galaxy | <https://esahubble.org/images/opo0328a/> | NASA/ESA and The Hubble Heritage Team (STScI/AURA) | CC BY 4.0 |
| `galaxies/ngc5866.jpg` | NGC 5866 | <https://esahubble.org/images/opo0624a/> | NASA, ESA, and The Hubble Heritage Team (STScI/AURA) | CC BY 4.0 |
| `galaxies/ngc4449.jpg` | NGC 4449 | <https://esahubble.org/images/heic0711a/> | NASA, ESA, A. Aloisi (STScI/ESA), and The Hubble Heritage (STScI/AURA)-ESA/Hubble Collaboration | CC BY 4.0 |
| `galaxies/m83.jpg` | M83 | <https://www.eso.org/public/images/eso0825a/> | ESO | CC BY 4.0 |
| `galaxies/ngc1232.jpg` | NGC 1232 | <https://www.eso.org/public/images/eso9845d/> | ESO | CC BY 4.0 |
| `galaxies/ngc5128.jpg` | NGC 5128 Centaurus A | <https://www.eso.org/public/images/eso1221a/> | ESO | CC BY 4.0 |
| `galaxies/ngc4565.jpg` | NGC 4565 | <https://www.eso.org/public/images/eso0525a/> | ESO | CC BY 4.0 |
| `galaxies/m87.jpg` | M87 | <https://www.eso.org/public/images/eso1907b/> | ESO | CC BY 4.0 |
| `galaxies/lmc.jpg` | Large Magellanic Cloud (VISTA, near-infrared) | <https://www.eso.org/public/images/eso1914a/> | ESO/VMC Survey | CC BY 4.0 |

Licence statements: ESA/Hubble <https://esahubble.org/copyright/>, ESO <https://www.eso.org/public/copyright/>,
Solar System Scope <https://www.solarsystemscope.com/textures/>, NASA <https://www.nasa.gov/nasa-brand-center/images-and-media/>.

## Suggested in-app credit text

> Earth, Mars, Mercury, Venus, Jupiter, Saturn, Uranus and Neptune textures: Solar System Scope
> (solarsystemscope.com), CC BY 4.0. Earth at night: NASA Earth Observatory (Suomi NPP VIIRS,
> NASA GSFC). Earth elevation: NOAA NCEI ETOPO 2022. Moon: NASA's Scientific Visualization Studio / LRO.
> Mars elevation: NASA MGS MOLA Science Team. Moons, Titan, Pluto: NASA / JPL / USGS Astrogeology;
> NASA / JHUAPL / SwRI. Star map: NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2:
> ESA/Gaia/DPAC. Galaxy images: NASA, ESA and The Hubble Heritage Team (STScI/AURA), S. Beckwith (STScI),
> A. Aloisi (STScI/ESA), A. Zezas and J. Huchra (CfA); ESO; ESO/VMC Survey — CC BY 4.0, cropped and
> background-subtracted.

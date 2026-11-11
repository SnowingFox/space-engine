#!/bin/sh
# Record of the conversions used to produce public/textures/ from assets-src/raw/ (run from the project root).
# Sources and licences: public/textures/CREDITS.md. Raw files are untrusted data: python runs with -I and
# only ever receives their paths as arguments.
set -eu
R=assets-src/raw; O=public/textures; G=$R/galaxies; U=$R/usgs; E=$R/etopo
T() { .texvenv/bin/python -I scripts/textures/textool.py "$@"; }
SKY() { .texvenv/bin/python -I scripts/textures/sky_tonemap.py "$@"; }
GAL() { .texvenv/bin/python -I scripts/textures/galaxy.py sprite "$@"; }
mkdir -p $O/galaxies

# Earth
cp $R/sss/8k_earth_daymap.jpg $O/earth_color.jpg
T jpg $R/nasa/BlackMarble_2016_3km.jpg $O/earth_night.jpg 4096 2048 --quality 88
T jpg $R/sss/8k_earth_clouds.jpg $O/earth_clouds.jpg 8192 4096 --gray --quality 85
T height-nc $O/earth_height.png 4096 2048 $E/etopo2022_60s_band0.nc $E/etopo2022_60s_band1a.nc \
  $E/etopo2022_60s_band1b.nc $E/etopo2022_60s_band2.nc $E/etopo2022_60s_band3.nc
# Moon (SVS maps are already centred on 0 deg longitude)
T jpg $R/svs/lroc_color_poles_8k.tif $O/moon_color.jpg 8192 4096
T height-tif $O/moon_height.png 4096 2048 $R/svs/ldem_16.tif --scale 1000
# Mars (MOLA MEGDR is 0..360 -> roll)
cp $R/sss/8k_mars.jpg $O/mars_color.jpg
T height-img $O/mars_height.png 4096 2048 $R/pds/megt90n000eb.img --cols 5760 --rows 2880 --roll
# Other planets + ring
T jpg $R/sss/8k_mercury.jpg $O/mercury_color.jpg 4096 2048
T jpg $R/sss/8k_venus_surface.jpg $O/venus_surface.jpg 4096 2048
cp $R/sss/4k_venus_atmosphere.jpg $O/venus_color.jpg
cp $R/sss/8k_jupiter.jpg $O/jupiter_color.jpg
cp $R/sss/8k_saturn.jpg $O/saturn_color.jpg
cp $R/sss/2k_uranus.jpg $O/uranus_color.jpg
cp $R/sss/2k_neptune.jpg $O/neptune_color.jpg
.texvenv/bin/python -I -c "
import sys
from PIL import Image
Image.open(sys.argv[1]).convert('RGBa').resize((4096, 250), Image.LANCZOS).convert('RGBA').save(sys.argv[2], optimize=True)
" $R/sss/8k_saturn_ring_alpha.png $O/saturn_ring.png
# Sky
SKY $R/svs/milkyway_2020_8k_gal.exr $O/sky_milkyway.jpg 8192 4096 --gain 2.0
SKY $R/svs/starmap_2020_8k_gal.exr $O/sky_stars.jpg 8192 4096 --gain 2.0
# Moons / dwarf planets (--roll where the USGS product is centred on 180 deg)
T jpg $U/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif $O/io_color.jpg 4096 2048 --fill 6
T jpg $U/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif $O/europa_color.jpg 4096 2048 --roll --gray --fill 6
T jpg $U/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif $O/ganymede_color.jpg 4096 2048 --roll --fill 6
T jpg $U/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif $O/callisto_color.jpg 4096 2048 --roll --gray --fill 6
T jpg $U/Titan_ISS_P19658_Mosaic_Global_4km.tif $O/titan_color.jpg 2048 1024 --roll --gray --fill 6 --quality 90
T jpg $R/nasa/PIA11707_orig.jpg $O/pluto_color.jpg 4096 2048 --roll --fill 14
T jpg $U/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif $O/triton_color.jpg 2048 1024 --fill 6
T jpg $U/Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif $O/enceladus_color.jpg 4096 2048 --roll --gray --fill 6
# (enceladus_color.jpg was then remapped once: out = (in - mean) * 0.9 + 205, re-saved at quality 87)
# Galaxies
GAL $G/heic0506a.jpg $O/galaxies/m51.jpg --cx 0.40 --cy 0.50 --r 0.52
GAL $G/heic0719a.jpg $O/galaxies/m74.jpg --cx 0.50 --cy 0.50 --r 0.52
GAL $G/heic0710a.jpg $O/galaxies/m81.jpg --cx 0.50 --cy 0.50 --r 0.66
GAL $G/opo0501a.jpg $O/galaxies/ngc1300.jpg --cx 0.47 --cy 0.50 --r 0.84
GAL $G/opo9925a.jpg $O/galaxies/ngc4414.jpg --cx 0.50 --cy 0.50 --r 0.58
GAL $G/opo0328a.jpg $O/galaxies/m104.jpg --cx 0.50 --cy 0.47 --r 0.72
GAL $G/opo0624a.jpg $O/galaxies/ngc5866.jpg --cx 0.50 --cy 0.50 --r 0.50
GAL $G/eso0525a.jpg $O/galaxies/ngc4565.jpg --cx 0.49 --cy 0.49 --r 0.50 --inner 0.6
GAL $G/eso1907b.jpg $O/galaxies/m87.jpg --cx 0.50 --cy 0.50 --r 0.42
GAL $G/eso1914a.jpg $O/galaxies/lmc.jpg --cx 0.50 --cy 0.52 --r 0.52
GAL $G/heic0711a.jpg $O/galaxies/ngc4449.jpg --cx 0.50 --cy 0.45 --r 0.60
GAL $G/eso0825a.jpg $O/galaxies/m83.jpg --cx 0.48 --cy 0.52 --r 0.36
GAL $G/eso9845d.jpg $O/galaxies/ngc1232.jpg --cx 0.60 --cy 0.52 --r 0.47
GAL $G/eso1221a.jpg $O/galaxies/ngc5128.jpg --cx 0.47 --cy 0.50 --r 0.36

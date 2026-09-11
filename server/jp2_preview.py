"""Decode a local JPEG2000 into a bounded, georeferenced preview; retain original separately."""
import json
import sys
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine

def convert(source_path, target_path):
    with rasterio.Env(GDAL_NUM_THREADS="2", GDAL_CACHEMAX=64 * 1024 * 1024):
        with rasterio.open(source_path, driver="JP2OpenJPEG") as source:
            if not 1 <= source.count <= 16:
                raise ValueError("JP2 must contain 1 to 16 bands.")
            scale = min(1, 768 / max(source.width, source.height))
            width, height = max(1, round(source.width * scale)), max(1, round(source.height * scale))
            data = source.read(out_shape=(source.count, height, width), resampling=Resampling.nearest)
            transform = source.transform * Affine.scale(source.width / width, source.height / height)
            profile = dict(driver="GTiff", width=width, height=height, count=source.count, dtype=data.dtype, nodata=source.nodata)
            if source.crs:
                profile.update(crs=source.crs, transform=transform)
            with rasterio.open(target_path, "w", **profile) as target:
                target.write(data)
            return dict(width=source.width, height=source.height, bands=source.count, sampled=scale < 1)

if __name__ == "__main__":
    try:
        print(json.dumps(convert(sys.argv[1], sys.argv[2])))
    except Exception:
        print("JP2 could not be decoded. Upload a valid, uncompressed-from-archive JPEG2000 image.", file=sys.stderr)
        sys.exit(1)

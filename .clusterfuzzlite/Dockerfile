# ClusterFuzzLite build image for the Jazzer.js fuzz targets in fuzz/ (see fuzz/README.md).
# Ubuntu 24.04, see project.yaml. Pinned by digest; Dependabot (docker, /.clusterfuzzlite) proposes new ones.
FROM gcr.io/oss-fuzz-base/base-builder-javascript:ubuntu-24-04@sha256:612d5c3d93f8b3f53d54429ff2c563084b078948a2cb2b76e58a8e2a508ac073
COPY . $SRC/meridian
WORKDIR $SRC/meridian
COPY .clusterfuzzlite/build.sh $SRC/

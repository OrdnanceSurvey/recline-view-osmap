#!/bin/sh

rm -fr dist

echo "Building Recline"
echo "-----------------------------------------"

cd vendor/recline
python make all




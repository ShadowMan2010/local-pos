#!/usr/bin/env python3
"""Reads one image on stdin, prints the QR payload it finds, or nothing at all.

This is a second opinion for the delivery-photo path. OpenCV's detector finds QRs in glared,
low-contrast and sideways photos that jsQR misses, which is a real and recurring problem when a
delivery boy photographs a customer's screen. It is deliberately a *fallback-friendly* helper: the
Node side treats any failure here (missing python, missing cv2, crash, timeout) as "no answer" and
carries on with jsQR, so the POS never depends on this file working.

It is spawned per photo rather than kept alive, which costs ~0.7s of interpreter start-up. That is
a fair price for not having to supervise a long-lived child process at a shop till, where a hung
helper would be much worse than a slow one. A self-imposed deadline guarantees it always exits.
"""
import sys
import time
import numpy as np
import cv2

# Total budget for detection. The Node side also enforces a timeout, but exiting on our own first
# means we never get killed mid-write and we can report "gave up" cleanly.
BUDGET_SECONDS = 4.5

_start = time.monotonic()


def out_of_time():
    return (time.monotonic() - _start) > BUDGET_SECONDS


def rotations(img):
    """The picture turned the ways a phone actually hands it over, plus the inverted form a customer
    in dark mode shows (a light code on a dark background)."""
    flipped = cv2.bitwise_not(img)
    return (img, np.rot90(img, 1), np.rot90(img, 3),
            flipped, np.rot90(flipped, 1), np.rot90(flipped, 3))


def cap_size(img, limit=2400):
    """Shrink very large photos before handing them to the detector.

    A modern phone photo is 12MP or more, and a single detectAndDecode on an image that size can take
    several seconds on its own — long enough to overrun the deadline from inside one call, which is
    exactly what we cannot detect from outside. A QR is still perfectly readable at 2400px.
    """
    h, w = img.shape[:2]
    if max(h, w) <= limit:
        return img
    f = limit / float(max(h, w))
    return cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)


def decode(det, img):
    try:
        text, _, _ = det.detectAndDecode(img)
    except cv2.error:
        return None
    return text or None


def main():
    data = sys.stdin.buffer.read()
    if not data:
        return
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return
    img = cap_size(img)
    det = cv2.QRCodeDetector()

    # Stage 1: the picture as it arrived. Upright and turned are tried first because that is nearly
    # every real photo, and each successful one returns immediately.
    for variant in rotations(img):
        if out_of_time():
            return
        found = decode(det, np.ascontiguousarray(variant))
        if found:
            sys.stdout.write(found)
            return

    # Stage 2: a small code in a big photo gets more pixels per module if the frame is enlarged.
    # Only worth trying when the image is not already large, and only smooth interpolation helps —
    # nearest-neighbour leaves jagged edges that the detector reads as noise.
    if not out_of_time() and max(img.shape[:2]) < 2200:
        big = cv2.resize(img, None, fx=2.5, fy=2.5, interpolation=cv2.INTER_LANCZOS4)
        for variant in (big, np.rot90(big, 1), np.rot90(big, 3)):
            if out_of_time():
                return
            found = decode(det, np.ascontiguousarray(variant))
            if found:
                sys.stdout.write(found)
                return

    # Stage 3: the multi-code reader, which sometimes separates a weak code that the single reader
    # gives up on. Last because it is the most expensive and the rarest help.
    if not out_of_time():
        try:
            ok, texts, _, _ = det.detectAndDecodeMulti(img)
        except cv2.error:
            return
        if ok and texts:
            for text in texts:
                if text:
                    sys.stdout.write(text)
                    return


main()

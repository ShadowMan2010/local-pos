/* Reads painted pixels out of a screenshot.

   A splash screen fails in ways that leave the DOM looking perfect: a logo 404s and the <img> is still
   there, an image is served with no artwork and is still 100x50, a mark is drawn in a colour that matches
   the surface behind it. None of that shows up in getComputedStyle, which reports what was asked for
   rather than what was painted. These two numbers — how much of the region has ink in it, and how dark
   that ink gets — are what tell a logo that is really there from one that is not.

   sharp is already a project dependency, so this adds no weight to install. */
import sharp from 'sharp';

/**
 * @param {Buffer} png  a screenshot
 * @param {{x:number,y:number,w:number,h:number}} box  region in CSS pixels
 * @returns {Promise<{inkFraction:number,darkest:number}>}
 */
export async function analysePlate(png, box) {
  const { width, height } = await sharp(png).metadata();
  // Clamped to the screenshot, because a region hanging off the edge would make sharp throw rather than
  // report the part it could read, which turns a logo failure into a confusing test error.
  const x = Math.max(0, Math.min(box.x, width - 1));
  const y = Math.max(0, Math.min(box.y, height - 1));
  const w = Math.max(1, Math.min(box.w, width - x));
  const h = Math.max(1, Math.min(box.h, height - y));

  const { data, info } = await sharp(png)
    .extract({ left: x, top: y, width: w, height: h })
    // Straight to raw greyscale: the alpha is not interesting here and dropping it first means a
    // transparent region counts as ink, which would turn a blank plate into a passing check.
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let ink = 0;
  let darkest = 255;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < 200) ink++;
    if (data[i] < darkest) darkest = data[i];
  }
  return { inkFraction: ink / data.length, darkest };
}
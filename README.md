# WallSight

Browser-based augmented reality that shows what's inside a wall (studs, electrical, plumbing and HVAC) through a phone camera.

**[Try the demo →](https://r10forthewin.github.io/wallsight-demo/)** (on a phone, held upright)

Photos taken before the drywall goes up are stitched into a panorama. On site, you calibrate by aiming at a reference point, then pan and tilt the phone: the gyroscope moves the view so the hidden layers line up with the finished wall. Each system can be toggled on its own. If motion access is blocked, you can drag with a finger instead.

Runs entirely in the browser: Three.js for the panorama, OpenCV.js in a web worker for corner detection during calibration.

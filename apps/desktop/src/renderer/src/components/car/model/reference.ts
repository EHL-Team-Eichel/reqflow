/**
 * Contours traced from the supplied `BMW (hotwheels)2.stl` sedan body.
 * The STL uses y along the car, z up, and has detached wheels/axle rods. Only
 * the body silhouette guides these curves; the existing interior and selectable
 * panels are retained. Length, width and cabin height stay in the sketch's scale.
 * End caps are rounded rather than tracing the STL's underside and spoiler tips.
 */
export const BMW_REFERENCE = {
  // Axle centres measured on the detached tyres, mapped to the body endpoints.
  frontAxleX: 1.371,
  rearAxleX: -1.503,
  top: [
    [2.2, 0.8],
    [2.185, 0.835],
    [2.14, 0.87],
    [1.96, 0.893],
    [1.65, 0.976],
    [1.42, 1.01],
    [1.05, 1.042],
    [0.82, 1.004],
    [0.55, 1.146],
    [0.25, 1.349],
    [0, 1.476],
    [-0.3, 1.508],
    [-0.7, 1.511],
    [-1.1, 1.484],
    [-1.45, 1.421],
    [-1.75, 1.289],
    [-1.97, 1.192],
    [-2.13, 1.145],
    [-2.3, 1.143],
    [-2.4, 1.155],
    [-2.46, 1.137],
    [-2.515, 1.055],
    [-2.53, 1.01],
  ],
  // Plan view: taper into the bonnet, broad shoulders and a tucked-in rear deck.
  halfWidth: [
    [-2.53, 0.87],
    [-2.2, 0.88],
    [-1.75, 0.942],
    [-1.45, 0.95],
    [-0.7, 0.942],
    [0, 0.942],
    [0.82, 0.937],
    [1.42, 0.949],
    [1.65, 0.95],
    [1.96, 0.89],
    [2.2, 0.87],
  ],
  // Plane coordinates: (x,y) for side curves, (x,z) for bonnet/deck curves.
  // BMW-style shoulder crease sits below the handles, rising into the rear haunch.
  shoulder: [
    [2.08, 0.825],
    [1.65, 0.865],
    [0.82, 0.891],
    [0, 0.923],
    [-0.9, 0.965],
    [-1.75, 1.025],
    [-2.3, 1.065],
  ],
  // A shallow scallop catches the door surface and kicks up ahead of the rear arch.
  lowerDoor: [
    [0.91, 0.415],
    [0.55, 0.385],
    [-0.15, 0.398],
    [-0.68, 0.449],
    [-1.045, 0.515],
  ],
  sill: [
    [0.93, 0.245],
    [0.45, 0.23],
    [-0.55, 0.23],
    [-1.04, 0.245],
  ],
  bonnet: [
    [2.085, 0.25],
    [1.88, 0.32],
    [1.42, 0.39],
    [1.05, 0.42],
    [0.88, 0.46],
  ],
  rearDeck: [
    [-1.99, 0.47],
    [-2.15, 0.55],
    [-2.36, 0.61],
  ],
} as const;

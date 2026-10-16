void behavior(vec2 L, vec2 R, vec2 axis, Rule rule, out vec2 force, out vec2 strafe){
  vec2 forward = safenorm(axis);
  vec2 left = vec2(forward.y, -forward.x);
  L = vec2(dot(L, forward), dot(L, left));
  R = vec2(dot(R, forward), dot(R, left));
  vec4 baseterm = black_box(L, R, rule);
  vec4 mirrorterm = black_box(y_reflect(R), y_reflect(L), rule);
  force = baseterm.xy + y_reflect(mirrorterm.xy);
  strafe = baseterm.zw + y_reflect(mirrorterm.zw);
  // axial/lateral scale the LOCAL frame components (scaling world x/y caused the vertical bias)
  force  = forward * (force.x  * config_c.y) + left * (force.y  * config_c.z);
  strafe = forward * (strafe.x * config_c.y) + left * (strafe.y * config_c.z);
}

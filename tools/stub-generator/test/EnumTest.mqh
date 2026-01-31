// Test multiline enum and bitwise flags
enum ENUM_CHART_FLAGS {
    FLAG_SHOW_NONE = 0,
    FLAG_SHOW_LEGEND = 1,
    FLAG_SHOW_SCALE_LEFT = 2,
    FLAG_SHOW_SCALE_RIGHT = 4,
    FLAG_SHOW_SCALE_TOP = 8,
    FLAG_SHOW_SCALE_BOTTOM = 16,
    FLAG_SHOW_GRID = 32,
    FLAG_SHOW_DESCRIPTORS = 64,
    FLAG_SHOW_VALUE = 128,
    FLAG_SHOW_PERCENT = 256,
    FLAGS_SHOW_SCALES = (FLAG_SHOW_SCALE_LEFT + 
                        FLAG_SHOW_SCALE_RIGHT + 
                        FLAG_SHOW_SCALE_TOP + 
                        FLAG_SHOW_SCALE_BOTTOM),
    FLAGS_SHOW_ALL = (FLAG_SHOW_LEGEND + 
                     FLAGS_SHOW_SCALES + 
                     FLAG_SHOW_GRID + 
                     FLAG_SHOW_DESCRIPTORS + 
                     FLAG_SHOW_VALUE + 
                     FLAG_SHOW_PERCENT)
};

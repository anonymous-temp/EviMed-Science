package com.sentum.enums;

import lombok.Getter;

@Getter
public enum CacheNameEnum {

    EXAMPLE_CACHE("exampleCache", "This is an example cache"),
    CACHE_Clinical("Clinical", "Clinical cache"),
    CACHE_Packaging("Packaging", "Packaging"),
    CACHE_LARGE_PACKAGING("LargePackaging", "Large packaging"),
    SINGLE_MEDICATION("singleMedication", "单次用药"),
    UNIQUENES("uiquenes", "市场独特性" ),
    ECONOMY_TITLE("economy_title", "经济性标题"),
    ECONOMY("economy","经济性");;

    private String name;
    private String describe;

    CacheNameEnum(String name, String describe) {
        this.name = name;
        this.describe = describe;
    }

    public static boolean hasCache(String cacheName) {
        for (CacheNameEnum cache : CacheNameEnum.values()) {
            if (cache.getName().equals(cacheName)) {
                return true;
            }
        }
        return false;
    }
}

package com.sentum.evidencecomprehensive.domain.enums;

import lombok.Getter;

import java.util.HashMap;
import java.util.Map;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/8/12
 */
@Getter
public enum GuideQueryEnum {

    ZERO(0, 80f,100f, 80f,1000f, 10f, 800f, 800f),
    ONE(1, 80f,100f, 80f, 1000f, 10f, 800f, 800f),
    TWO(2, 64f, 80f, 64f, 800f, 8f, 640f, 640f),
    THREE(3, 50f, 64f, 50f, 640f, 6.4f, 500f, 500f),
    FOUR(4, 40f, 50f, 40f, 500f, 5f, 400f, 400f),
    FIVE(5, 32f, 40f, 32f, 400f, 4f, 320f, 320f),
    SIX(6, 25f,32f, 25f, 320f, 3.2f, 250f, 250f),
    SEVEN(7, 25f,32f, 25f, 320f, 3.2f, 250f, 250f),
    EIGHT(8, 25f,32f, 25f, 320f, 3.2f, 250f, 250f),
    NINE(9, 25f,32f, 25f, 320f, 3.2f, 250f, 250f),
    TEN(10, 25f,32f, 25f, 320f, 3.2f, 250f, 250f);

    private final int level;
    private final float zhPhraseBoost;
    private final float phraseBoost;
    private final float bestBoost;
    private final float titleBoost;
    private final float nrjsBoost;
    private final float keywordBoost;
    private final float pdfTxtBoost;
    
    GuideQueryEnum(int level, float zhPhraseBoost, float phraseBoost, float bestBoost, float titleBoost, float nrjsBoost, float keywordBoost, float pdfTxtBoost) {
        this.level = level;
        this.zhPhraseBoost = zhPhraseBoost;
        this.phraseBoost = phraseBoost;
        this.bestBoost = bestBoost;
        this.titleBoost = titleBoost;
        this.nrjsBoost = nrjsBoost;
        this.keywordBoost = keywordBoost;
        this.pdfTxtBoost = pdfTxtBoost;
    }
 
    private static final Map<Integer, GuideQueryEnum> cache = new HashMap<>();
    static {
        for (GuideQueryEnum value : GuideQueryEnum.values()) {
            cache.put(value.level, value);
        }
    }
    public static GuideQueryEnum of(int level) {
        return cache.get(level);
    }
}

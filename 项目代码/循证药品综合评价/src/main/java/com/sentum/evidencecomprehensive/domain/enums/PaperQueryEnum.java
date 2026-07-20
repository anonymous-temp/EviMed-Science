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
public enum PaperQueryEnum {

    ZERO(0, 80f,100f, 80f,1000f, 10f, 800f, 0.1f, 0.1f, 0.5f),
    ONE(1, 80f,100f, 80f, 1000f, 10f, 800f, 0.1f, 0.1f, 0.5f),
    TWO(2, 64f, 80f, 64f, 800f, 8f, 640f, 0.1f, 0.1f, 0.5f),
    THREE(3, 51f, 64f, 51f, 640f, 6.4f, 510f, 0.1f, 0.1f, 0.5f),
    FOUR(4, 25f, 32f, 25f, 320f, 3.2f, 250f, 0.1f, 0.1f, 0.5f),
    FIVE(5, 5f, 6.4f, 5f, 64f, 0.64f, 50f, 0.1f, 0.1f, 0.5f),
    SIX(6, 2.5f,3.2f, 2.5f, 32f, 0.32f, 25f, 0.1f, 0.1f, 0.5f),
    SEVEN(7, 2.5f,3.2f, 2.5f, 32f, 0.32f, 25f, 0.1f, 0.1f, 0.5f),
    EIGHT(8, 2.5f,3.2f, 2.5f, 32f, 0.32f, 25f, 0.1f, 0.1f, 0.5f),
    NINE(9, 2.5f,3.2f, 2.5f, 32f, 0.32f, 25f, 0.1f, 0.1f, 0.5f),
    TEN(10, 2.5f,3.2f, 2.5f, 32f, 0.32f, 25f, 0.1f, 0.1f, 0.5f);

    private final int level;
    private final float zhPhraseBoost;
    private final float phraseBoost;
    private final float bestBoost;
    private final float titleBoost;
    private final float summaryBoost;
    private final float keywordBoost;
    private final float tldrBoost;
    private final float resultBoost;
    private final float conclusionBoost;

    PaperQueryEnum(int level, float zhPhraseBoost, float phraseBoost, float bestBoost, float titleBoost, float summaryBoost, float keywordBoost, float tldrBoost, float resultBoost, float conclusionBoost) {
        this.level = level;
        this.zhPhraseBoost = zhPhraseBoost;
        this.phraseBoost = phraseBoost;
        this.bestBoost = bestBoost;
        this.titleBoost = titleBoost;
        this.summaryBoost = summaryBoost;
        this.keywordBoost = keywordBoost;
        this.tldrBoost = tldrBoost;
        this.resultBoost = resultBoost;
        this.conclusionBoost = conclusionBoost;
    }
 
    private static final Map<Integer, PaperQueryEnum> cache = new HashMap<>();
    static {
        for (PaperQueryEnum value : PaperQueryEnum.values()) {
            cache.put(value.level, value);
        }
    }
    public static PaperQueryEnum of(int level) {
        return cache.get(level);
    }
}

package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class SaveAnalysisResult {
    /**
     * 报告id
     */
    private String id;
    /**
     * 报告经济性得分
     */
    private String economicScore;
}

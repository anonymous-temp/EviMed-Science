package com.sentum.evidencecomprehensive.domain.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Description:
 * DateTime: 2024/4/16
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class PaperAndGuideIncludeDTO {
    /**
     * screenId 检索id（用于记录混合初筛和精筛得到的文献id的集合）
     */
    private String screenId;
    /**
     * searchQuery 检索条件的一句话（picos检索需要自行拼接）
     */
    private String searchQuery;
    /**
     * query es检索的query
     */
    private String query;
    /**
     * titleQuery es检索的titleQuery
     */
    private String titleQuery;
    /**
     * 同义词集合
     */
    private List<List<String>> wordList;
    /**
     * type 1-混合初筛；2-混合精筛（调用模型）
     */
    private Integer type;
    /**
     * language 数组，其中元素1-中文、2-英文（指南检索可以传值null）
     */
    private List<String> language;
    /**
     * status 1-文献、2-指南
     */
    private Integer status;
    /**
     * formatType 1-新版本（超说明书），2-老版本，3-中兴，4-循证，不传也是老版本
     */
    private Integer formatType;
}


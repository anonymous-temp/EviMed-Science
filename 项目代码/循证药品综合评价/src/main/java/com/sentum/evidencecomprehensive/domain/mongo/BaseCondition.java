package com.sentum.evidencecomprehensive.domain.mongo;

import com.sentum.evidencecomprehensive.domain.dto.*;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/6
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class BaseCondition {
    /**
     * 检索的唯一id
     */
    private String id;
    /**
     * 药品信息
     */
    private List<Drug> drugs;
    /**
     * 疾病信息
     */
    private List<Disease> diseases;
    /**
     * 对比药物
     */
    private List<InterventionAndOutcome> interventions;
    /**
     * 结局指标
     */
    private List<InterventionAndOutcome> outcomes;
    /**
     * 研究类型
     */
    private List<Integer> studyType;
    /**
     * 是否需要翻译 1翻译 2不翻译，默认1翻译
     */
    private Integer isTranslate = 1;
    
    
    /**
     * 去修饰之后的疾病信息--指南
     */
    private List<Disease> guideWipeDiseases;
    /**
     * 去修饰之后的疾病信息--文献
     */
    private List<Disease> literatureWipeDiseases;

    // ####################### 回显数据 ##########################
    private String guideEchoData;
    private PaperPICOConditionDTO paperPICOConditionDTO;
    private PaperModelConditionDTO paperModelConditionDTO;
    private ConditionLiteratureAlter conditionLiteratureAlter;
    private ConditionGuideAlter conditionGuideAlter;
}

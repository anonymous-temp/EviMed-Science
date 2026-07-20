package com.sentum.evidencecomprehensive.domain.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.sentum.evidencecomprehensive.domain.vo.req.PICORequest;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/2/24
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class PaperPICOConditionDTO {
    @ApiModelProperty("药品信息")
    private List<Drug> drugs;
    @ApiModelProperty("疾病信息")
    private List<Disease> diseases;
    @ApiModelProperty("对比药物")
    private List<InterventionAndOutcome> interventions;
    @ApiModelProperty("结局指标")
    private List<InterventionAndOutcome> outcomes;
    @ApiModelProperty("研究类型")
    private List<Integer> studyType;
    @ApiModelProperty("是否需要翻译 1翻译 2不翻译，默认1翻译")
    private Integer isTranslate = 1;
    @JsonIgnore
    private Long updateTime = Instant.now().toEpochMilli();
}

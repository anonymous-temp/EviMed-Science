package com.sentum.evidencecomprehensive.pojo.dto;

import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Arrays;
import java.util.List;

/**
 * 疾病、参比药物检索的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "ConditionDto", description = "存储检索条件的dto类")
public class ConditionDto {
    @ApiModelProperty("保存的课题进行检索才需要传值，否则不传值")
    private String id;
    @ApiModelProperty("是否需要翻译 1翻译 2不翻译，默认1翻译")
    private Integer isTranslate = 1;
    @ApiModelProperty("药品信息")
    private List<Drug> drugs;
    @ApiModelProperty("疾病信息")
    private List<Disease> diseases;
    @ApiModelProperty("对比药物")
    private List<InterventionAndOutcome> interventions;
    @ApiModelProperty("结局指标")
    private List<InterventionAndOutcome> outcomes;
    @ApiModelProperty("用户勾选的研究类型")
    private List<Integer> studyType = Arrays.asList(0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 9, 10, 13);

    @ApiModelProperty("弹框指南检索起始年份")
    private String guideStartYear;
    @ApiModelProperty("弹框指南检索结束年份")
    private String guideEndYear;
    @ApiModelProperty("弹框文献检索起始年份")
    private String literatureStartYear;
    @ApiModelProperty("弹框文献检索结束年份")
    private String literatureEndYear;
    @ApiModelProperty("弹框中文期刊来源")
    private List<String> zhJournal = Arrays.asList("北大核心", "南大核心", "CSCD", "科技核心");
    @ApiModelProperty("弹框英文期刊来源")
    private List<String> enJournal = Arrays.asList("JCR(Q1)", "JCR(Q2)", "JCR(Q3)", "JCR(Q4)", "JCR(N/A)");

    @ApiModelProperty("去修饰之后的疾病信息--指南")
    private List<Disease> guideWipeDiseases;
    @ApiModelProperty("去修饰之后的疾病信息--文献")
    private List<Disease> literatureWipeDiseases;

    @ApiModelProperty("检索式")
    private String mode;
    @ApiModelProperty("中英文扩展 1选中 0未选中")
    private String zhEnExtension;
    @ApiModelProperty("同义词扩展  1选中 0未选中")
    private String synonymExtension;
}

package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

@ApiModel("返回前台的药品评价苏大一使用的vo类")
@Data
public class DrugDataSdyVo {
    @ApiModelProperty("不良反应")
    private List<DataVo<AdverseReactionVo>> adverseReaction;


    @ApiModelProperty("与同类药物对比临床优势")
    private List<DataVo<String>> treatmentAdvantage;

    @ApiModelProperty("成分规范")
    private List<DataVo<String>> component;

    @ApiModelProperty("指南/文献mate")
    private List<DataVo<List<GuidelinesVo>>> guidelines;

    @ApiModelProperty("相关内容")
    private RelatedVo related;

    public DrugDataSdyVo() {
        this.adverseReaction = new ArrayList<>();
        this.treatmentAdvantage = new ArrayList<>();
        this.component = new ArrayList<>();
        this.guidelines = new ArrayList<>();
        this.related = new RelatedVo();
    }


}

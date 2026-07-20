package com.sentum.pojo.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@AllArgsConstructor
@ApiModel("返回前台的药品评价前置信息使用的vo类")
public class DrugDataInfoVo {
    /**
     * 说明书信息
     */
    @ApiModelProperty("说明书信息")
    private List<DataVo<InstructionDataVo>> instructions;
    /**
     * 指南/文献mate
     */
    @ApiModelProperty("指南/文献mate")
    private List<DataVo<List<GuidelinesVo>>> guidelines;
    /**
     * 其他
     */
    @ApiModelProperty("其他")
    private List<DataVo<OtherVo>> other;

    @ApiModelProperty("相关内容")
    private RelatedVo related;

    public DrugDataInfoVo(){
        this.instructions = new ArrayList<>();
        this.guidelines = new ArrayList<>();
        this.other = new ArrayList<>();
    }

}

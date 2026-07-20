package com.sentum.pojo.vo;

import com.sentum.pojo.DrugInfoNew;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@ApiModel("返回前台的药品评价使用的vo类")
public class DataVo1<T>  {
    @ApiModelProperty(value = "药品名称")
    private String drugName;
    @ApiModelProperty(value = "药品id")
    private String drugId;
    @ApiModelProperty(value = "详情信息")
    private T data;


    public DataVo1(String drugName, String drugId, T data) {
        this.drugName = drugName;
        this.drugId = drugId;
        this.data = data;
    }

    public DataVo1(String drugName, String drugId) {
        this.drugName = drugName;
        this.drugId = drugId;
    }

    public DataVo1(DrugInfoNew drugInfoNew) {
        this.drugName = drugInfoNew.getDrugName();
        this.drugId = drugInfoNew.getId();
    }
}

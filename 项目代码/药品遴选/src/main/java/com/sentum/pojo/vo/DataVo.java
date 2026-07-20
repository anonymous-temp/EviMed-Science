package com.sentum.pojo.vo;

import com.sentum.pojo.DrugInfoNew;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@NoArgsConstructor
@ApiModel("返回前台的药品评价使用的vo类")
public class DataVo<T>  {
    @ApiModelProperty(value = "药品名称")
    private String drugName;
    @ApiModelProperty(value = "药品id")
    private String drugId;
    @ApiModelProperty(value = "详情信息")
    private T data;
    @ApiModelProperty(value = "附加信息")
    private T dataOther;

    public DataVo(String drugName, String drugId, T data,T data1) {
        this.drugName = drugName;
        this.drugId = drugId;
        this.data = data;
        this.dataOther = data1;
    }

    public DataVo(DrugInfoNew drugInfoNew) {
        this.drugName = drugInfoNew.getDrugName();
        this.drugId = drugInfoNew.getId();
    }
}

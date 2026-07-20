package com.sentum.pojo.dto;

import com.sentum.pojo.vo.DrugDataSdyVo;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

@Data
@AllArgsConstructor
@NoArgsConstructor()
@ApiModel("接收前台的药品评价苏大一使用的dto类")
public class DrugDataSdyDto extends DrugDataSdyVo implements Serializable {

    /**
     * 搜索id
     */
    @ApiModelProperty("检索id")
    private String SearchId;
}

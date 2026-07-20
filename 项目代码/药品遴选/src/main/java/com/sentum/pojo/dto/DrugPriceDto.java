package com.sentum.pojo.dto;


import com.sentum.pojo.DrugPrice;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 保存用户输入的药品价格的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class DrugPriceDto {
    @ApiModelProperty("用户输入的药品价格数据")
    private List<DrugPrice> list;
}

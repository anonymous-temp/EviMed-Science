package com.sentum.pojo.dto;

import com.sentum.pojo.SaveDrugPrice;
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
public class SaveDrugPriceDto {
    @ApiModelProperty("用户输入的药品价格数据")
    private List<SaveDrugPrice> list;
}

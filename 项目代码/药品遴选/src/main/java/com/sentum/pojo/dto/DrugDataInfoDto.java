package com.sentum.pojo.dto;

import com.sentum.pojo.vo.DrugDataInfoVo;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.io.Serializable;
import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("遴选前置信息接收类")
@Document("drug_data_info")
public class DrugDataInfoDto extends DrugDataInfoVo implements Serializable {
    /**
     * 搜索id
     */
    @ApiModelProperty("搜索id")
    private String searchId;

    @ApiModelProperty("经济性相关内容接收")
    private SaveDrugPriceDto drugPrice;
}

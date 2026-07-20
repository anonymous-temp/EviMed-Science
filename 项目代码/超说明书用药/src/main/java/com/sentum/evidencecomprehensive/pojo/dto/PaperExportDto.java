package com.sentum.evidencecomprehensive.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 批量/单个导出文献的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "PaperExportDto", description = "批量/单个导出文献的dto类")
public class PaperExportDto {
    @ApiModelProperty("需要导出的id的集合")
    private List<String> ids;
    @ApiModelProperty("导出的类型，1-xlsx；2-pdf；3-xml")
    private Integer type;
}

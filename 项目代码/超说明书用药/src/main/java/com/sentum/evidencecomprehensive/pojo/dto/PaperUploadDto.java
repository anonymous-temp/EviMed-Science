package com.sentum.evidencecomprehensive.pojo.dto;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.web.multipart.MultipartFile;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "PaperUploadDto", description = "文献上传pdf的dto类")
public class PaperUploadDto {
    @ApiModelProperty("文献id")
    private String id;
    @ApiModelProperty("上传的文献pdf")
    private MultipartFile file;
}
